// Files' vocabulary and its own corner of Firestore, dashboard side.
// Mirrors internal/files (Go, in the projectBV service) exactly — the two must
// agree on every path and every signed string, so they are kept as close to
// identical as a JS file and a Go file can be.
import { TOKEN } from './secret'

export const ROOT = ['from_projectbv', 'files']

export const PATHS = {
  agents: () => [...ROOT, 'agents'],
  agent: (id) => [...ROOT, 'agents', id],
  enabled: (id) => [...ROOT, 'enabled', id],
  enabledAll: () => [...ROOT, 'enabled'],
  command: (id) => [...ROOT, 'commands', id],
  result: (id) => [...ROOT, 'results', id],
}

// The projectBV fleet heartbeat, written by the Go agent. Read only.
export const FLEET_DEVICES = ['from_projectbv', 'fleet', 'devices']
export const ONLINE_MS = 3 * 60 * 1000

// Where sealed file bytes are relayed in Storage. `out/` is device→dashboard
// (a PULL), `in/` is dashboard→device (a PUSH).
export const STORAGE_OUT = (id) => `projectbv/files/out/${id}`
export const STORAGE_IN = (id) => `projectbv/files/in/${id}`

export const CMD = {
  LIST: 'list',
  STAT: 'stat',
  PULL: 'pull',
  PUSH: 'push',
  MKDIR: 'mkdir',
  RENAME: 'rename',
  MOVE: 'move',
  COPY: 'copy',
  DELETE: 'delete',
  SEARCH: 'search',
}

// A command id has to make collisions effectively impossible: it is the only thing
// telling the device a new command from a re-delivered copy of the last one.
let seq = 0
export function makeId() {
  seq = (seq + 1) % 1e6
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// --- signing --------------------------------------------------------------
const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function hmac(msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
}

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
}

export const sign = (payload) => hmac(stable(payload))
export const commandSig = (c) => hmac(`${c.id}|${c.cmd}|${c.ts}|${stable(c.args ?? {})}`)
