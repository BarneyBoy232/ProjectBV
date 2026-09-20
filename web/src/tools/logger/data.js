// Logger tool data layer — reads the fleet, sends signed commands, reads results.
// Its own Firestore partition (from_projectbv/logger), never touching Remote's or
// Monitor's collections: a device can be on for Logger and off for the others.
import { db } from '../../firebase'
import { collection, doc, getDocs, onSnapshot, setDoc } from 'firebase/firestore'
import { PATHS, FLEET_DEVICES, ONLINE_MS, makeId, signCommand } from './protocol'
import { loadRemoteKnownDevices } from '../../fleet'

function toMillis(v) {
  if (typeof v === 'number') return v
  if (v && typeof v.toMillis === 'function') return v.toMillis()
  return null
}

// Every projectBV fleet device, annotated with whether the Logger agent is live on
// it. Switches are read separately from the agents' heartbeats: a device can be
// switched on before its agent has ever checked in, and the dashboard shows that
// rather than pretending the device is off.
export async function loadDevices() {
  const [fleetSnap, agentSnap, switchSnap, labelSnap, remoteKnown] = await Promise.all([
    getDocs(collection(db, ...FLEET_DEVICES)),
    getDocs(collection(db, ...PATHS.agents())),
    getDocs(collection(db, ...PATHS.enabledAll())),
    getDocs(collection(db, 'from_projectbv', 'fleet', 'labels')),
    loadRemoteKnownDevices(),
  ])

  const agents = new Map()
  agentSnap.forEach((d) => agents.set(d.id, d.data()))
  const switches = new Map()
  switchSnap.forEach((d) => switches.set(d.id, !!(d.data() || {}).enabled))
  const labels = new Map(labelSnap.docs.map((d) => [d.id, (d.data() || {}).label || '']))

  const now = Date.now()
  const isOn = (id, a) => (switches.has(id) ? switches.get(id) : !!(a && a.enabled))

  const row = (id, fleet, a, known) => {
    const seen = a ? toMillis(a.lastSeen) : null
    return {
      id,
      name: labels.get(id) || (fleet && fleet.name) || (a && a.host) || (known && known.host) || id,
      fleetOnline: !!(fleet && toMillis(fleet.lastSeen) && now - toMillis(fleet.lastSeen) < ONLINE_MS),
      // Whether this device runs a Logger-capable agent at all. An agent build from
      // before Logger existed writes nothing here — that is "not supported", told
      // apart from "supported but silent" so the dashboard never waits forever.
      hasAgent: !!a,
      agentOnline: !!(a && a.online && seen && now - seen < ONLINE_MS),
      agentLastSeen: seen,
      streaming: !!(a && a.streaming),
      version: (a && a.version) || null,
      enabled: isOn(id, a),
    }
  }

  const rows = fleetSnap.docs.map((d) => row(d.id, d.data(), agents.get(d.id)))
  agentSnap.forEach((d) => {
    if (!rows.some((r) => r.id === d.id)) rows.push(row(d.id, null, d.data()))
  })
  // A device the BV Remote agent knows but Logger's own agent has never reported:
  // show it (as "needs agent update") rather than hiding a machine you can already
  // reach from the Remote tool.
  remoteKnown.forEach((known, id) => {
    if (!rows.some((r) => r.id === id)) rows.push(row(id, null, null, known))
  })
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

// Turn Logger on or off for one device. The agent installs everywhere and stays
// dormant until this says otherwise.
export function setEnabled(deviceId, on) {
  return setDoc(doc(db, ...PATHS.enabled(deviceId)), { enabled: !!on, ts: Date.now() })
}

// The secret never travels — we sign the command's fields and store only the signature.
export async function sendCommand(deviceId, cmd, args) {
  const id = makeId()
  const ts = Date.now()
  const fields = { id, cmd, args: args || {}, ts }
  const sig = await signCommand(fields)
  await setDoc(doc(db, ...PATHS.command(deviceId)), { ...fields, sig })
  return id
}

// Per-device serial queue so the single command/result docs can't be clobbered.
const queues = new Map()
export function runCommand(deviceId, cmd, args, timeoutMs = 15000) {
  const prev = queues.get(deviceId) || Promise.resolve()
  const next = prev.catch(() => {}).then(() => _run(deviceId, cmd, args, timeoutMs))
  const tail = next.catch(() => {})
  queues.set(deviceId, tail)
  tail.finally(() => { if (queues.get(deviceId) === tail) queues.delete(deviceId) })
  return next
}
function _run(deviceId, cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let off = null
    let timer = null
    const cleanup = () => { if (off) off(); if (timer) clearTimeout(timer) }
    sendCommand(deviceId, cmd, args)
      .then((id) => {
        off = onSnapshot(
          doc(db, ...PATHS.result(deviceId)),
          (snap) => { const d = snap.data(); if (d && d.id === id) { cleanup(); resolve(d) } },
          (err) => { cleanup(); reject(err) },
        )
        timer = setTimeout(() => { cleanup(); reject(new Error(`No response after ${Math.round(timeoutMs / 1000)}s — the agent may be offline.`)) }, timeoutMs)
      })
      .catch(reject)
  })
}
