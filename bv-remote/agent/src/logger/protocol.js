// Logger's own vocabulary and its own corner of Firestore.
//
// Logger ships inside the BV Remote agent's process, but it is not part of the
// Remote tool: its own partition, its own command bus, its own presence document,
// its own on/off switch, and its own signalling. Nothing here reads or writes
// anything under `remotedesk` or `monitor`, and nothing there touches this.
//
// It watches one device live — screen, microphone, speaker output, and the real
// keyboard/mouse the person at the machine is using — for exactly as long as the
// operator keeps the view open. It never controls the machine, and it stores
// nothing.
import { TOKEN } from './secret.js'

export const ROOT = ['from_projectbv', 'logger']

export const PATHS = {
  agents: () => [...ROOT, 'agents'],
  agent: (id) => [...ROOT, 'agents', id],
  enabled: (id) => [...ROOT, 'enabled', id],
  enabledAll: () => [...ROOT, 'enabled'],
  command: (id) => [...ROOT, 'commands', id],
  result: (id) => [...ROOT, 'results', id],
  session: (id) => [...ROOT, 'sessions', id],
  adminCandidates: (id) => [...ROOT, 'sessions', id, 'adminCandidates'],
  deviceCandidates: (id) => [...ROOT, 'sessions', id, 'deviceCandidates'],
}

// The projectBV fleet heartbeat, written by the Go agent. Read only — it is how
// Logger knows a device exists before its own agent has ever spoken.
export const FLEET_DEVICES = ['from_projectbv', 'fleet', 'devices']
export const ONLINE_MS = 3 * 60 * 1000

export const CMD = {
  PING: 'ping',
  START_SESSION: 'start_session', // { nonce } — begin a live watch session
  STOP_SESSION: 'stop_session', // { nonce } — tear the live session down
  PERF: 'perf', // one performance snapshot (+ the streaming verdict)
}

// --- signing --------------------------------------------------------------
// Commands and signalling travel through a world-readable Firestore, so they carry
// an HMAC over their own fields. The secret itself never leaves the machine.
const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function hmac(msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
}

// Sorted keys, so both ends hash the same string for the same object.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
}

// Compare without returning early on the first differing character.
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

// Blob signing (used for WebRTC offer/answer/ICE payloads).
export const signBlob = (payload) => hmac(stable(payload))
export async function verifyBlob(payload, sig) {
  if (typeof sig !== 'string') return false
  return same(sig, await hmac(stable(payload)))
}

// A command's signature covers its identity, its verb, its time and its arguments.
export const commandSig = (c) => hmac(`${c.id}|${c.cmd}|${c.ts}|${stable(c.args ?? {})}`)
export async function verifyCommand(c) {
  if (!c || typeof c.sig !== 'string') return false
  return same(c.sig, await commandSig(c))
}
