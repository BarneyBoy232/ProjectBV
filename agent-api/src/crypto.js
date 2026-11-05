// Signing and sealing — byte-for-byte compatible with internal/agentapi/crypto.go
// and the dashboard tools' protocol.js. The Worker is the ONLY place besides the
// device binary that holds AGENTAPI_TOKEN, so a valid signature is proof the
// command came from here.

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

// stable mirrors protocol.js / crypto.go stable(): primitives via JSON, arrays in
// order, objects with keys sorted, no whitespace.
export function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
}

async function hmacKey(token) {
  return crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

// commandSig signs `${id}|${cmd}|${ts}|${stable(args)}`, exactly what the device
// verifies in verifyCommand.
export async function commandSig(token, { id, cmd, ts, args }) {
  const key = await hmacKey(token)
  const msg = `${id}|${cmd}|${ts}|${stable(args ?? {})}`
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
}

// --- sealing (AES-GCM, key = SHA-256(token)) ------------------------------
let keyCache = new Map()
async function aesKey(token) {
  if (keyCache.has(token)) return keyCache.get(token)
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(token))
  const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  keyCache.set(token, k)
  return k
}

const unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

// open decrypts a sealed result the device wrote (12-byte IV prepended, base64).
export async function open(token, base64) {
  const raw = unb64(base64)
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(token), raw.slice(12))
  return new TextDecoder().decode(new Uint8Array(plain))
}

// makeId mirrors protocol.js makeId(): collision-proof, distinguishes a fresh
// command from a re-delivered copy of the last one.
let seq = 0
export function makeId() {
  seq = (seq + 1) % 1e6
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// sha256hex is used to store only the HASH of an API key, never the key itself.
export async function sha256hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)))
}
