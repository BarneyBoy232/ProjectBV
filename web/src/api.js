// Data layer for the projectBV dashboard — talks to your Runic Firebase.
// Everything lives inside the `from_projectbv` sub-project partition:
//   from_projectbv/fleet/manifest/{name}   — what to deploy
//   from_projectbv/fleet/devices/{id}       — device check-ins (written by agents)
// Installer/files go to Storage at projectbv/{apps,files}/<filename>, and the
// public download URL is stored in the manifest entry.
import { db, storage, ensureAuth } from './firebase'
import { collection, doc, getDocs, setDoc, deleteDoc } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'

const manifestCol = collection(db, 'from_projectbv', 'fleet', 'manifest')
const devicesCol = collection(db, 'from_projectbv', 'fleet', 'devices')
// Friendly names live in their own collection, NOT on the device document. The
// agent's heartbeat PATCHes that document without an updateMask, which replaces
// it wholesale — anything the dashboard wrote there would be gone inside a minute.
// Keeping labels separate also means renaming needs no agent change at all.
const labelsCol = collection(db, 'from_projectbv', 'fleet', 'labels')
// The lock switch — the second security layer. A locked device is tamper-proof:
// the Firestore rules refuse every control write aimed at it (command, session,
// enable toggle, across every tool) for everyone, including an operator, including
// by accident. It still checks in, so it stays visible — "linked but untouchable".
const locksCol = collection(db, 'from_projectbv', 'fleet', 'locks')

// SHA-256 of a file, computed in the browser (matches what the agent verifies).
async function sha256hex(file) {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Every manifest entry, each carrying its own document id. The id matters: a
// single app can have several entries (one fleet-wide, one per targeted device),
// so anything that removes an entry has to name the document, not the app.
export async function listManifest() {
  const snap = await getDocs(manifestCol)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

// Devices carry their document id: that id is the device's name in a manifest
// entry's `targets`, so anything aiming an install at one machine needs it.
export async function listDevices() {
  const [snap, labels, locks] = await Promise.all([getDocs(devicesCol), getDocs(labelsCol), getDocs(locksCol)])
  const nameById = new Map(labels.docs.map((d) => [d.id, (d.data() || {}).label || '']))
  const lockById = new Map(locks.docs.map((d) => [d.id, (d.data() || {}).locked === true]))
  return snap.docs.map((d) => {
    const label = nameById.get(d.id) || ''
    return { id: d.id, ...d.data(), label, display: label || d.data().name || d.id, locked: lockById.get(d.id) === true }
  })
}

// Lock or unlock a device. Operator-only (rules enforce it). Locking it makes the
// rules refuse every control write to it until it is deliberately unlocked.
export async function setDeviceLock(deviceId, locked) {
  return setDoc(doc(locksCol, deviceId), { locked: !!locked, ts: Date.now() })
}

// Rename a device for the dashboard's benefit. An empty label clears it and the
// machine goes back to showing its hostname.
export async function setDeviceLabel(deviceId, label) {
  const clean = String(label || '').trim()
  if (!clean) return deleteDoc(doc(labelsCol, deviceId))
  return setDoc(doc(labelsCol, deviceId), { label: clean, ts: Date.now() })
}

// Every distinct set of bytes gets its own path, because the path includes their
// checksum. Reusing a path would replace the bytes a LIVE manifest entry points
// at, and every device would then reject that download as failing its recorded
// sha256 — silently breaking a deployment that was working until the next push.
// Two apps sharing a file name, or the same version rebuilt, cannot collide.
async function upload(kind, name, version, sha256, file) {
  await ensureAuth()
  const safe = (v) => String(v).replace(/[^a-zA-Z0-9._-]/g, '-')
  const storageRef = ref(storage, `projectbv/${kind}/${safe(name)}/${safe(version)}-${sha256.slice(0, 12)}/${file.name}`)
  await uploadBytes(storageRef, file)
  return getDownloadURL(storageRef)
}

export const AGENT_NAME = 'projectBV'
export const REMOTE_AGENT_NAME = 'BVRemoteAgent'

// A manifest entry named after an agent IS that agent — every device hands the
// file straight to its own installer. The device side matches the name without
// caring about case, so this check must not care either, and it has to cover the
// per-device form ("projectBV--DESKTOP1") too.
function refuseAgentName(name) {
  const n = String(name).trim().toLowerCase()
  for (const reserved of [AGENT_NAME.toLowerCase(), REMOTE_AGENT_NAME.toLowerCase()]) {
    if (n === reserved || n.startsWith(reserved + '--')) {
      throw new Error(`"${name}" is the name of a projectBV agent — pick a different name.`)
    }
  }
}

// scope: 'machine' (default) runs the installer as the agent itself, which is what
// a machine-wide .msi needs. 'user' runs it as whoever is signed in, in their
// session — needed by per-user installers, and the only way one installs on a
// standard account without asking for an admin password.
export async function deployApp({ name, version, file, silentArgs, scope }) {
  refuseAgentName(name)
  const sha256 = await sha256hex(file)
  const url = await upload('apps', name, version, sha256, file)
  await setDoc(doc(manifestCol, name), {
    name, version, type: 'app', url, sha256,
    silentArgs: silentArgs || [],
    scope: scope === 'user' ? 'user' : 'machine',
  })
}

// The fleet agent updating itself. The entry is named after the agent's own
// service, which is how each device knows to hand the installer its own binary
// and step aside instead of waiting for it. --record-version tells the installer
// which version to write down once the swap has worked, so it matches this entry
// exactly and no device installs it twice.
// targets: leave empty for the whole fleet, or name one device to try it there
// first. A targeted update gets its own document so it can sit alongside (or
// ahead of) the fleet-wide one.
//
// publishedUrl: agents released before this update reject any download URL that
// doesn't end in .exe, and a Firebase Storage link never does — it carries a
// query string. To reach those devices at all, publish the same file somewhere
// with a plain .exe address (a GitHub release asset) and paste it here. The
// checksum still comes from the local file, so a URL serving anything else is
// rejected by every device.
// The key is uploaded here and served from Firebase Storage — never a public
// release, because this binary embeds the fleet's Tailscale auth key. It is the
// same file that goes on the USB; pick it here to push it to devices already on
// the fleet.
export async function deployAgentUpdate({ version, file, targets, publishedUrl }) {
  if (!file) throw new Error('Choose the built projectBV-key.exe.')
  const sha256 = await sha256hex(file)
  const stored = await upload('agent', AGENT_NAME, version, sha256, file)

  // Agents older than 1.1.0 read the installer type off the whole URL, so a
  // Firebase Storage link ("...projectBV-key.exe?alt=media&token=...") looks like
  // type ".exe?alt=media..." to them and is rejected before it is ever downloaded.
  // Publishing the same bytes at a plain .exe address is the only way to reach
  // those devices. The checksum still comes from the local file, so a URL serving
  // anything else is refused by every agent.
  let url = stored
  if (publishedUrl) {
    const clean = String(publishedUrl).trim()
    if (!/\.exe$/i.test(clean)) {
      throw new Error('The published URL has to end in .exe — that is the whole point of it.')
    }
    url = clean
  }

  const entry = {
    name: AGENT_NAME, version, type: 'app', url, sha256,
    silentArgs: ['--record-version', version, '--no-prompt'],
    scope: 'machine',
    publishedAt: Date.now(),
  }
  // One document per named device, so asking for two devices can never quietly
  // become "every device" — the most expensive mistake this button can make.
  const named = (targets || []).filter(Boolean)
  if (named.length === 0) {
    await setDoc(doc(manifestCol, AGENT_NAME), entry)
    return
  }
  await Promise.all(named.map((id) =>
    setDoc(doc(manifestCol, `${AGENT_NAME}--${id}`), { ...entry, targets: [id] })))
}

// A plain file dropped on the device, no execution. targets works exactly as it
// does for an agent update: empty means the whole fleet, and a named device gets
// its own document so a targeted drop can sit alongside the fleet-wide one
// instead of overwriting it.
export async function deployFile({ name, version, file, dest, targets }) {
  refuseAgentName(name)
  const sha256 = await sha256hex(file)
  const url = await upload('files', name, version, sha256, file)
  const entry = { name, version, type: 'file', url, sha256, dest }

  const named = (targets || []).filter(Boolean)
  if (named.length === 0) {
    await setDoc(doc(manifestCol, name), entry)
    return
  }
  await Promise.all(named.map((id) =>
    setDoc(doc(manifestCol, `${name}--${id}`), { ...entry, targets: [id] })))
}

export async function removeEntry(id) {
  await deleteDoc(doc(manifestCol, id))
}

// Remove a device from the fleet list (a decommissioned or stale machine). Clears
// both its heartbeat doc and its friendly label. Operator-only, enforced by rules.
// A device whose agent is still alive will simply reappear on its next check-in.
export async function removeDevice(deviceId) {
  await Promise.all([
    deleteDoc(doc(devicesCol, deviceId)).catch(() => {}),
    deleteDoc(doc(labelsCol, deviceId)).catch(() => {}),
    deleteDoc(doc(locksCol, deviceId)).catch(() => {}),
  ])
}
