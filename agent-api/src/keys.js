// API keys and the audit log, stored in Cloudflare KV.
//
// A key is shown to the operator exactly once, at creation. Only its SHA-256 hash
// is stored, so a dump of KV never yields a working key. Each key carries a scope:
// which devices it may touch, and whether it may do anything ('full') or only read
// ('read'). Revoking a key or letting it expire cuts the AI off instantly.

import { sha256hex } from './crypto.js'

const KEY_PREFIX = 'key:'      // key:<sha256(ak)>  -> record
const AUDIT_PREFIX = 'audit:'  // audit:<descTs>-<rand> -> entry (reverse-chron)

function randomKey() {
  const b = new Uint8Array(24)
  crypto.getRandomValues(b)
  const body = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `ak_live_${body}`
}

// mintKey creates a key, stores its hashed record, returns the plaintext ONCE.
export async function mintKey(env, { label, devices, caps, expiresAt }) {
  const key = randomKey()
  const hash = await sha256hex(key)
  const record = {
    id: hash.slice(0, 12),
    label: label || 'unnamed',
    devices: devices === 'all' ? 'all' : Array.isArray(devices) ? devices : [],
    caps: caps === 'read' ? 'read' : 'full',
    expiresAt: expiresAt || 0,
    created: Date.now(),
    lastUsed: 0,
  }
  await env.AGENTAPI_KV.put(KEY_PREFIX + hash, JSON.stringify(record))
  return { key, record }
}

// resolveKey hashes a presented key and returns its record, or null if unknown,
// revoked or expired.
export async function resolveKey(env, presented) {
  if (!presented || !presented.startsWith('ak_live_')) return null
  const hash = await sha256hex(presented.trim())
  const raw = await env.AGENTAPI_KV.get(KEY_PREFIX + hash)
  if (!raw) return null
  const rec = JSON.parse(raw)
  if (rec.expiresAt && Date.now() > rec.expiresAt) return null
  rec._hash = hash
  return rec
}

// touchKey records last-used, best-effort (never blocks a request).
export async function touchKey(env, rec) {
  try {
    rec.lastUsed = Date.now()
    const { _hash, ...clean } = rec
    await env.AGENTAPI_KV.put(KEY_PREFIX + _hash, JSON.stringify(clean))
  } catch { /* ignore */ }
}

export function keyAllowsDevice(rec, device) {
  if (rec.devices === 'all') return true
  return Array.isArray(rec.devices) && rec.devices.includes(device)
}

// Capability gate: 'read' keys may only use the read-only verbs.
const READ_ONLY = new Set(['list_devices', 'read', 'list', 'info'])
export function keyAllowsAction(rec, action) {
  if (rec.caps === 'full') return true
  return READ_ONLY.has(action)
}

export async function listKeys(env) {
  const out = []
  let cursor
  do {
    const page = await env.AGENTAPI_KV.list({ prefix: KEY_PREFIX, cursor })
    for (const k of page.keys) {
      const raw = await env.AGENTAPI_KV.get(k.name)
      if (raw) {
        const r = JSON.parse(raw)
        delete r._hash
        out.push(r)
      }
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  out.sort((a, b) => b.created - a.created)
  return out
}

// revokeAll cuts every key at once — the key half of the dashboard's kill switch.
export async function revokeAll(env) {
  let n = 0
  let cursor
  do {
    const page = await env.AGENTAPI_KV.list({ prefix: KEY_PREFIX, cursor })
    for (const k of page.keys) { await env.AGENTAPI_KV.delete(k.name); n++ }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return n
}

export async function revokeKey(env, id) {
  let cursor
  do {
    const page = await env.AGENTAPI_KV.list({ prefix: KEY_PREFIX, cursor })
    for (const k of page.keys) {
      const raw = await env.AGENTAPI_KV.get(k.name)
      if (raw && JSON.parse(raw).id === id) {
        await env.AGENTAPI_KV.delete(k.name)
        return true
      }
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return false
}

// --- audit log ------------------------------------------------------------
// Entries are keyed by a reverse timestamp so a prefix list returns newest first.
export async function audit(env, entry) {
  try {
    const rev = (1e15 - Date.now()).toString().padStart(16, '0')
    const name = `${AUDIT_PREFIX}${rev}-${Math.random().toString(36).slice(2, 8)}`
    // Keep audit entries for 30 days, then let KV expire them automatically.
    await env.AGENTAPI_KV.put(name, JSON.stringify(entry), { expirationTtl: 30 * 24 * 3600 })
  } catch { /* audit must never fail the action */ }
}

export async function listAudit(env, limit = 100) {
  const page = await env.AGENTAPI_KV.list({ prefix: AUDIT_PREFIX, limit })
  const out = []
  for (const k of page.keys) {
    const raw = await env.AGENTAPI_KV.get(k.name)
    if (raw) out.push(JSON.parse(raw))
  }
  return out
}
