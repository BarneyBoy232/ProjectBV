// Logger tool — command vocabulary, Firestore paths, and signing. Self-contained
// and browser-safe (no node imports). The signing here must hash byte-for-byte the
// same strings as the agent's bv-remote/agent/src/logger/protocol.js, or the agent
// rejects everything the dashboard sends.
import { TOKEN } from './secret'

const ROOT = ['from_projectbv', 'logger']
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

// The projectBV fleet heartbeat (written by the device agents).
export const FLEET_DEVICES = ['from_projectbv', 'fleet', 'devices']
export const ONLINE_MS = 3 * 60 * 1000

export const CMD = {
  PING: 'ping',
  START_SESSION: 'start_session',
  STOP_SESSION: 'stop_session',
  PERF: 'perf',
}

let _seq = 0
export function makeId() {
  _seq = (_seq + 1) % 1e6
  return `${Date.now().toString(36)}-${_seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// --- signing (HMAC-SHA256) -------------------------------------------------
const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
async function hmac(msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
}
// Recursive, sorted-key stringify — the same shape the agent hashes.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
}

// A command's signature covers its identity, verb, time and arguments.
export const signCommand = (c) => hmac(`${c.id}|${c.cmd}|${c.ts}|${stable(c.args ?? {})}`)

// Blob signing for the WebRTC offer/answer/ICE payloads.
export const signBlob = (payload) => hmac(stable(payload))
export async function verifyBlob(payload, sig) {
  if (typeof sig !== 'string') return false
  return same(sig, await hmac(stable(payload)))
}
