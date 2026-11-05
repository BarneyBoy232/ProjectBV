// projectBV Agent API — a Vercel Edge Function at /api/agent.
//
// This is the whole backend: an AI (Claude Code, as an MCP connector) presents an
// ak_live_ key; this function validates it against Firestore, signs a command with
// the shared secret, relays it over the device bus, and returns the sealed result
// decrypted. The signing secret lives ONLY here (a Vercel env var) and in the device
// agent — never in the browser — so a valid signature is itself proof a command came
// from here. Keys are minted in the dashboard (operator, Google sign-in) straight
// into Firestore; this function only ever READS a key to check it.
//
// Config comes from Vercel env vars so nothing secret or key-shaped is committed:
//   AGENTAPI_TOKEN       the signing secret (must equal the agent's agentApiToken)
//   FIREBASE_PROJECT_ID  public
//   FIREBASE_API_KEY     public web apiKey

export const config = { runtime: 'edge' }

// --- crypto (byte-identical to internal/agentapi/crypto.go) ----------------
const enc = new TextEncoder()
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
}
async function commandSig(token, { id, cmd, ts, args }) {
  const key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}|${cmd}|${ts}|${stable(args ?? {})}`)))
}
let aesKeyCache
async function aesKey(token) {
  if (!aesKeyCache) {
    const raw = await crypto.subtle.digest('SHA-256', enc.encode(token))
    aesKeyCache = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  }
  return aesKeyCache
}
async function open(token, b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, await aesKey(token), raw.slice(12))
  return new TextDecoder().decode(new Uint8Array(plain))
}
async function sha256hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))) }
let seq = 0
function makeId() { seq = (seq + 1) % 1e6; return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}` }

// --- Firestore REST (public apiKey; same as the agent) ---------------------
function fsUrl(env, path) {
  return `https://firestore.googleapis.com/v1/projects/${env.pid}/databases/(default)/documents/${path}?key=${env.key}`
}
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } }
  return { mapValue: { fields: encFields(v) } }
}
function encFields(o) { const f = {}; for (const [k, v] of Object.entries(o)) f[k] = toValue(v); return f }
function fromValue(v) {
  if ('stringValue' in v) return v.stringValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('booleanValue' in v) return v.booleanValue
  if ('nullValue' in v) return null
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue)
  if ('mapValue' in v) return decFields(v.mapValue.fields || {})
  return null
}
function decFields(f) { const o = {}; for (const [k, v] of Object.entries(f)) o[k] = fromValue(v); return o }
async function fsGet(env, path) {
  const r = await fetch(fsUrl(env, path))
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`firestore get ${r.status}`)
  const j = await r.json()
  return decFields(j.fields || {})
}
async function fsSet(env, path, fields) {
  const r = await fetch(fsUrl(env, path), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encFields(fields) }) })
  if (!r.ok) throw new Error(`firestore set ${r.status}`)
}
async function fsList(env, collection) {
  const r = await fetch(fsUrl(env, collection))
  if (r.status === 404) return []
  if (!r.ok) throw new Error(`firestore list ${r.status}`)
  const j = await r.json()
  return (j.documents || []).map((d) => ({ id: d.name.split('/').pop(), ...decFields(d.fields || {}) }))
}

const P = {
  command: (d) => `from_projectbv/agentapi/commands/${d}`,
  result: (d) => `from_projectbv/agentapi/results/${d}`,
  agents: () => 'from_projectbv/agentapi/agents',
  enabledAll: () => 'from_projectbv/agentapi/enabled',
  key: (h) => `from_projectbv/agentapi/keys/${h}`,
  audit: (id) => `from_projectbv/agentapi/audit/${id}`,
}
const ONLINE_MS = 3 * 60 * 1000

// --- key validation --------------------------------------------------------
async function resolveKey(env, presented) {
  if (!presented || !presented.startsWith('ak_live_')) return null
  const rec = await fsGet(env, P.key(await sha256hex(presented.trim())))
  if (!rec) return null
  if (rec.expiresAt && Date.now() > rec.expiresAt) return null
  return rec
}
const keyAllowsDevice = (rec, d) => rec.devices === 'all' || (Array.isArray(rec.devices) && rec.devices.includes(d))
const READ_ONLY = new Set(['list_devices', 'read', 'list', 'info'])
const keyAllowsAction = (rec, a) => rec.caps === 'full' || READ_ONLY.has(a)

class ScopeError extends Error {}

// --- device operations -----------------------------------------------------
const ACTIONS = {
  exec: (a) => ({ cmd: 'exec', args: pick(a, ['shell', 'line', 'program', 'args', 'cwd', 'timeoutMs']) }),
  read: (a) => ({ cmd: 'read', args: { path: a.path } }),
  write: (a) => ({ cmd: 'write', args: { path: a.path, dataB64: a.dataB64 } }),
  list: (a) => ({ cmd: 'list', args: { path: a.path || '' } }),
  delete: (a) => ({ cmd: 'delete', args: { path: a.path } }),
  info: () => ({ cmd: 'info', args: {} }),
}
function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r }

async function runAction(env, rec, action, raw) {
  const spec = ACTIONS[action]
  if (!spec) throw new ScopeError(`unknown action: ${action}`)
  const device = raw.device
  if (!device) throw new ScopeError('a device id is required')
  if (!keyAllowsAction(rec, action)) throw new ScopeError(`this key is read-only and cannot ${action}`)
  if (!keyAllowsDevice(rec, device)) throw new ScopeError(`this key is not scoped to device "${device}"`)

  const { cmd, args } = spec(raw)
  const id = makeId()
  const ts = Date.now()
  const sig = await commandSig(env.token, { id, cmd, ts, args })
  await fsSet(env, P.command(device), { id, cmd, ts, args, sig })

  const budget = Math.min((Number(args.timeoutMs) || 120000) + 15000, 115000)
  const result = await poll(env, device, id, budget)
  auditWrite(env, { ts, device, action, keyId: rec.id, keyLabel: rec.label, summary: summarise(action, args), ok: result ? result.ok !== false : null, pending: !result, outcome: result ? briefOutcome(result) : undefined })
  if (!result) return { pending: true, id, device, note: 'still running — fetch with get_result using this id' }
  return result
}
async function poll(env, device, id, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const d = await fsGet(env, P.result(device))
    if (d && d.id === id && d.box) return JSON.parse(await open(env.token, d.box))
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}
async function fetchResult(env, rec, device, id) {
  if (!keyAllowsDevice(rec, device)) throw new ScopeError(`this key is not scoped to device "${device}"`)
  const d = await fsGet(env, P.result(device))
  if (d && d.id === id && d.box) {
    const result = JSON.parse(await open(env.token, d.box))
    auditWrite(env, { ts: Date.now(), device, action: 'result', keyId: rec.id, keyLabel: rec.label, summary: `completed ${id}`, ok: result.ok !== false, pending: false, outcome: briefOutcome(result) })
    return result
  }
  return { pending: true, id, device }
}
async function listDevices(env, rec) {
  const [agents, switches] = await Promise.all([fsList(env, P.agents()), fsList(env, P.enabledAll())])
  const armed = new Map(switches.map((s) => [s.id, s.enabled === true]))
  const now = Date.now()
  return agents.filter((a) => keyAllowsDevice(rec, a.id)).map((a) => ({
    device: a.id, host: a.host || a.id,
    online: a.online === true && a.lastSeen && now - a.lastSeen < ONLINE_MS,
    armed: armed.has(a.id) ? armed.get(a.id) : a.enabled === true,
    agentVersion: a.version || null,
  })).sort((x, y) => x.device.localeCompare(y.device))
}
function summarise(action, args) {
  if (action === 'exec') return args.program ? `exec ${args.program}` : `exec: ${(args.line || '').slice(0, 120)}`
  if (args.path) return `${action} ${args.path}`
  return action
}
function briefOutcome(r) {
  if (r && r.result && typeof r.result.exit === 'number') return `exit ${r.result.exit}${r.result.timedOut ? ' (timed out)' : ''}`
  if (r && r.ok === false) return 'error'
  return 'ok'
}
function auditWrite(env, entry) {
  // Best-effort; never fails the action. A short id keeps the doc tiny.
  fsSet(env, P.audit(makeId()), entry).catch(() => {})
}

// --- MCP (JSON-RPC 2.0) ----------------------------------------------------
const SERVER = { name: 'projectBV Agent API', version: '2.0.0' }
const DEVICE = { type: 'string', description: 'Target device id (its hostname in the fleet).' }
const TOOLS = [
  { name: 'list_devices', description: 'List the devices this key may control, with whether each is online. Call this first.', inputSchema: { type: 'object', properties: {} } },
  { name: 'run_powershell', description: 'Run a PowerShell command line on the device as SYSTEM (full administrator); returns stdout, stderr and exit code. Use for installing/removing software, the registry, services, users — anything an elevated shell can do.', inputSchema: { type: 'object', properties: { device: DEVICE, line: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['device', 'line'] } },
  { name: 'run_command', description: 'Run a program directly (no shell) with args, as SYSTEM.', inputSchema: { type: 'object', properties: { device: DEVICE, program: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['device', 'program'] } },
  { name: 'read_file', description: 'Read a file (base64, capped at 512 KB; use run_powershell for bigger).', inputSchema: { type: 'object', properties: { device: DEVICE, path: { type: 'string' } }, required: ['device', 'path'] } },
  { name: 'write_file', description: 'Write a file. Provide text, or base64 in dataB64.', inputSchema: { type: 'object', properties: { device: DEVICE, path: { type: 'string' }, text: { type: 'string' }, dataB64: { type: 'string' } }, required: ['device', 'path'] } },
  { name: 'list_dir', description: 'List a directory (empty path lists drive letters).', inputSchema: { type: 'object', properties: { device: DEVICE, path: { type: 'string' } }, required: ['device'] } },
  { name: 'delete_path', description: 'Send a file/folder to the Recycle Bin (recoverable).', inputSchema: { type: 'object', properties: { device: DEVICE, path: { type: 'string' } }, required: ['device', 'path'] } },
  { name: 'machine_info', description: 'Basic facts about the device.', inputSchema: { type: 'object', properties: { device: DEVICE }, required: ['device'] } },
  { name: 'get_result', description: 'Fetch the result of a long command that returned a pending id.', inputSchema: { type: 'object', properties: { device: DEVICE, id: { type: 'string' } }, required: ['device', 'id'] } },
]
function toB64(text) { let b = ''; for (const x of enc.encode(text)) b += String.fromCharCode(x); return btoa(b) }
async function callTool(env, rec, name, a = {}) {
  switch (name) {
    case 'list_devices': return listDevices(env, rec)
    case 'run_powershell': return runAction(env, rec, 'exec', { device: a.device, shell: 'powershell', line: a.line, timeoutMs: a.timeoutMs })
    case 'run_command': return runAction(env, rec, 'exec', { device: a.device, program: a.program, args: a.args, cwd: a.cwd, timeoutMs: a.timeoutMs })
    case 'read_file': return runAction(env, rec, 'read', { device: a.device, path: a.path })
    case 'write_file': return runAction(env, rec, 'write', { device: a.device, path: a.path, dataB64: a.dataB64 || toB64(a.text || '') })
    case 'list_dir': return runAction(env, rec, 'list', { device: a.device, path: a.path })
    case 'delete_path': return runAction(env, rec, 'delete', { device: a.device, path: a.path })
    case 'machine_info': return runAction(env, rec, 'info', { device: a.device })
    case 'get_result': return fetchResult(env, rec, a.device, a.id)
    default: throw new ScopeError(`unknown tool: ${name}`)
  }
}
async function handleRpc(msg, env, rec) {
  const { id, method, params } = msg || {}
  if (id === undefined || id === null) return null // notification
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER } }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (method === 'tools/call') {
    try {
      const out = await callTool(env, rec, params?.name, params?.arguments || {})
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] } }
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } }
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
}

// --- the handler -----------------------------------------------------------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' }
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } })

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  const env = { token: process.env.AGENTAPI_TOKEN, pid: process.env.FIREBASE_PROJECT_ID, key: process.env.FIREBASE_API_KEY }
  if (!env.token || !env.pid || !env.key) return json({ error: 'server not configured' }, 500)

  if (request.method === 'GET') return json({ service: 'projectBV Agent API', ok: true, mcp: 'POST JSON-RPC here with ?key=ak_live_... or an Authorization: Bearer header' })
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const url = new URL(request.url)
  const auth = request.headers.get('Authorization') || ''
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : url.searchParams.get('key') || ''
  const rec = await resolveKey(env, presented)
  if (!rec) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'invalid or missing API key' } }, 401)

  const body = await request.json().catch(() => null)
  if (!body) return json({ error: 'invalid JSON-RPC body' }, 400)
  const res = Array.isArray(body)
    ? (await Promise.all(body.map((m) => handleRpc(m, env, rec)))).filter(Boolean)
    : await handleRpc(body, env, rec)
  return res === null || (Array.isArray(res) && res.length === 0) ? new Response(null, { status: 204, headers: CORS }) : json(res)
}
