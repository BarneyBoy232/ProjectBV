// A tiny Firestore REST client for the Worker — the same approach the Go agent
// uses (internal/firestore): the public web apiKey, typed-value JSON, no SDK.
//
// The Worker only ever: writes a signed command, reads a device's presence, and
// polls a sealed result. All three paths are allowed by firestore.rules without an
// identity (commands are gated by the signature, not a login).

const BASE = 'https://firestore.googleapis.com/v1'

export class Firestore {
  constructor(projectId, apiKey) {
    this.projectId = projectId
    this.apiKey = apiKey
  }

  url(path) {
    return `${BASE}/projects/${this.projectId}/databases/(default)/documents/${path}?key=${this.apiKey}`
  }

  async get(path) {
    const r = await fetch(this.url(path))
    if (r.status === 404) return null
    if (!r.ok) throw new Error(`firestore get HTTP ${r.status}: ${await r.text()}`)
    const j = await r.json()
    return decodeFields(j.fields || {})
  }

  async set(path, fields) {
    const body = JSON.stringify({ fields: encodeFields(fields) })
    const r = await fetch(this.url(path), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (!r.ok) throw new Error(`firestore set HTTP ${r.status}: ${await r.text()}`)
  }

  async listDocs(collectionPath) {
    const r = await fetch(this.url(collectionPath))
    if (r.status === 404) return []
    if (!r.ok) throw new Error(`firestore list HTTP ${r.status}: ${await r.text()}`)
    const j = await r.json()
    return (j.documents || []).map((d) => ({
      id: d.name.split('/').pop(),
      ...decodeFields(d.fields || {}),
    }))
  }
}

// --- typed value (de)coding -----------------------------------------------
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } }
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } }
  return { stringValue: String(v) }
}

function encodeFields(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = toValue(v)
  return out
}

function fromValue(v) {
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('booleanValue' in v) return v.booleanValue
  if ('nullValue' in v) return null
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue)
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {})
  return null
}

function decodeFields(fields) {
  const out = {}
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v)
  return out
}
