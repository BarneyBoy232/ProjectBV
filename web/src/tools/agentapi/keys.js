// Key minting, listing, revoking, and the kill switch — all client-side Firestore
// writes made as the signed-in operator (rules let only an operator create/list/
// delete key records). The key is shown once; only its SHA-256 hash is stored, so the
// database never holds a usable key. The Vercel function looks a key up by that hash
// to validate it, and holds the signing secret that actually commands devices.
import { db } from '../../firebase'
import { collection, doc, getDocs, setDoc, deleteDoc } from 'firebase/firestore'
import { PATHS } from './protocol'
import { setArmed } from './devices'

const enc = new TextEncoder()
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function randomKey() {
  const b = new Uint8Array(24)
  crypto.getRandomValues(b)
  return 'ak_live_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

// The MCP connector URL for Claude Code: this site's own origin + the key, so there
// is nothing else to configure.
export function connectorUrl(key) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/api/agent?key=${key}`
}

// Generate a key, store its hashed record, arm the devices it covers (so it works at
// once), and return the plaintext key + connector URL ONCE. durationMs > 0 sets an
// expiry on both the key and the arming.
export async function generateKey({ label, devices, caps, durationMs }, allDeviceIds) {
  const key = randomKey()
  const hash = await sha256hex(key)
  const scopeDevices = devices === 'all' ? 'all' : (Array.isArray(devices) ? devices : [])
  const rec = {
    id: hash.slice(0, 12),
    label: label || 'claude',
    devices: scopeDevices,
    caps: caps === 'read' ? 'read' : 'full',
    expiresAt: durationMs > 0 ? Date.now() + durationMs : 0,
    created: Date.now(),
  }
  await setDoc(doc(db, ...PATHS.key(hash)), rec)
  const targets = scopeDevices === 'all' ? (allDeviceIds || []) : scopeDevices
  await Promise.all(targets.map((id) => setArmed(id, true, rec.expiresAt)))
  return { key, record: rec, connector: connectorUrl(key) }
}

export async function listKeys() {
  const snap = await getDocs(collection(db, ...PATHS.keys()))
  return snap.docs.map((d) => ({ hash: d.id, ...d.data() })).sort((a, b) => (b.created || 0) - (a.created || 0))
}

export async function revokeKey(hash) {
  await deleteDoc(doc(db, ...PATHS.key(hash)))
}

// The one safety control: revoke every key and disarm every device at once, so the AI
// is cut off instantly.
export async function cutEverythingOff(allDeviceIds) {
  const keys = await listKeys()
  await Promise.all(keys.map((k) => deleteDoc(doc(db, ...PATHS.key(k.hash)))))
  await Promise.all((allDeviceIds || []).map((id) => setArmed(id, false)))
}

// Recent audit entries written by the Vercel function (what the AI did).
export async function listAudit(limit = 100) {
  const snap = await getDocs(collection(db, ...PATHS.audit()))
  return snap.docs.map((d) => d.data()).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, limit)
}
