// The device operations, shared by the REST and MCP surfaces. Each call signs a
// command, writes it to the device's bus, waits for the sealed result, decrypts
// it, and records an audit entry. Nothing here trusts the caller: the key's scope
// (which devices, read-only vs full) is enforced before a command is ever written.

import { commandSig, open, makeId } from './crypto.js'
import { audit, keyAllowsDevice, keyAllowsAction } from './keys.js'

const P = {
  command: (d) => `from_projectbv/agentapi/commands/${d}`,
  result: (d) => `from_projectbv/agentapi/results/${d}`,
  enabled: (d) => `from_projectbv/agentapi/enabled/${d}`,
  agents: () => `from_projectbv/agentapi/agents`,
  enabledAll: () => `from_projectbv/agentapi/enabled`,
}

const ONLINE_MS = 3 * 60 * 1000

// Map an action name (what REST/MCP expose) to the device command verb + the args
// it carries. Keeping this table here means both surfaces stay identical.
const ACTIONS = {
  exec: (a) => ({ cmd: 'exec', args: pick(a, ['shell', 'line', 'program', 'args', 'cwd', 'timeoutMs']) }),
  read: (a) => ({ cmd: 'read', args: { path: a.path } }),
  write: (a) => ({ cmd: 'write', args: { path: a.path, dataB64: a.dataB64 } }),
  list: (a) => ({ cmd: 'list', args: { path: a.path || '' } }),
  delete: (a) => ({ cmd: 'delete', args: { path: a.path } }),
  info: () => ({ cmd: 'info', args: {} }),
}

function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

export class ScopeError extends Error {}

// run performs one action on one device, end to end.
export async function run(env, fs, rec, action, rawArgs) {
  const spec = ACTIONS[action]
  if (!spec) throw new ScopeError(`unknown action: ${action}`)
  const device = rawArgs.device
  if (!device) throw new ScopeError('a device id is required')
  if (!keyAllowsAction(rec, action)) throw new ScopeError(`this key is read-only and cannot ${action}`)
  if (!keyAllowsDevice(rec, device)) throw new ScopeError(`this key is not scoped to device "${device}"`)

  // The device must be armed by the operator, or it will ignore the command. Fail
  // fast with a clear reason instead of timing out.
  const en = await fs.get(P.enabled(device))
  if (!en || en.enabled !== true) {
    throw new ScopeError(`device "${device}" is not armed for the Agent API — arm it in the projectBV dashboard`)
  }

  const { cmd, args } = spec(rawArgs)
  const id = makeId()
  const ts = Date.now()
  const sig = await commandSig(env.AGENTAPI_TOKEN, { id, cmd, ts, args })
  await fs.set(P.command(device), { id, cmd, ts, args, sig })

  // How long to wait for the device. exec can set its own budget; give the poll a
  // margin over it, but keep synchronous waits bounded so a long install returns a
  // ticket to fetch later rather than hanging the request.
  const budget = Math.min((Number(args.timeoutMs) || 120000) + 15000, 115000)
  const result = await poll(fs, env, device, id, budget)

  const entry = {
    ts, device, action, keyId: rec.id, keyLabel: rec.label,
    summary: summarise(action, args),
    ok: result ? result.ok !== false : null,
    pending: !result,
    error: result && result.ok === false ? result.error : undefined,
    outcome: result ? briefOutcome(result) : undefined,
  }
  await audit(env, entry)

  if (!result) {
    return { pending: true, id, device, note: 'still running — fetch with the result action using this id' }
  }
  return result
}

// poll fetches the result doc until its id matches the command we sent, or the
// budget runs out (then the caller gets a pending ticket).
async function poll(fs, env, device, id, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const d = await fs.get(P.result(device))
    if (d && d.id === id && d.box) {
      return JSON.parse(await open(env.AGENTAPI_TOKEN, d.box))
    }
    await sleep(1000)
  }
  return null
}

// fetchResult serves a pending ticket: the same decrypt, no new command.
export async function fetchResult(env, fs, rec, device, id) {
  if (!keyAllowsDevice(rec, device)) throw new ScopeError(`this key is not scoped to device "${device}"`)
  const d = await fs.get(P.result(device))
  if (d && d.id === id && d.box) {
    const result = JSON.parse(await open(env.AGENTAPI_TOKEN, d.box))
    // Close the audit loop: a long-running command whose first call returned a
    // pending ticket now gets its outcome recorded, so a hands-off operator isn't
    // left with an entry stuck on "running…".
    await audit(env, {
      ts: Date.now(), device, action: 'result', keyId: rec.id, keyLabel: rec.label,
      summary: `completed ${id}`, ok: result.ok !== false, pending: false,
      error: result.ok === false ? result.error : undefined, outcome: briefOutcome(result),
    })
    return result
  }
  return { pending: true, id, device }
}

// listDevices returns the devices this key may reach, with their presence + armed
// state so the AI knows which ones it can actually act on right now.
export async function listDevices(env, fs, rec) {
  const [agents, switches] = await Promise.all([
    fs.listDocs(P.agents()),
    fs.listDocs(P.enabledAll()),
  ])
  const armed = new Map(switches.map((s) => [s.id, s.enabled === true]))
  const now = Date.now()
  return agents
    .filter((a) => keyAllowsDevice(rec, a.id))
    .map((a) => ({
      device: a.id,
      host: a.host || a.id,
      online: a.online === true && a.lastSeen && now - a.lastSeen < ONLINE_MS,
      armed: armed.has(a.id) ? armed.get(a.id) : a.enabled === true,
      agentVersion: a.version || null,
    }))
    .sort((x, y) => x.device.localeCompare(y.device))
}

function summarise(action, args) {
  if (action === 'exec') return args.program ? `exec ${args.program}` : `exec: ${(args.line || '').slice(0, 120)}`
  if (args.path) return `${action} ${args.path}`
  return action
}

// briefOutcome is the one-line result recorded in the audit log, so the log says
// what came back, not just that something ran.
function briefOutcome(r) {
  if (r && r.result && typeof r.result.exit === 'number') {
    return `exit ${r.result.exit}${r.result.timedOut ? ' (timed out)' : ''}`
  }
  if (r && r.ok === false) return 'error'
  return 'ok'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
