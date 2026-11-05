// MCP surface — a remote Model Context Protocol server over HTTP (JSON-RPC 2.0).
// Point Claude (or any MCP client) at /mcp with an API key and the device actions
// appear as tools. Every tool call runs through the same scope-checked ops as the
// REST API, so an MCP client can never exceed its key's scope.

import { run, fetchResult, listDevices, ScopeError } from './ops.js'

const SERVER = { name: 'projectBV Agent API', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

const DEVICE = { type: 'string', description: 'Target device id (its hostname in the fleet).' }

const TOOLS = [
  {
    name: 'list_devices',
    description: 'List the fleet devices this key may control, with whether each is online and armed. Call this first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_powershell',
    description: 'Run a PowerShell command line on the device as SYSTEM (full administrator) and return stdout, stderr and the exit code. Use this to install/remove software, edit the registry, manage services and users, or anything else an elevated shell can do.',
    inputSchema: {
      type: 'object',
      properties: {
        device: DEVICE,
        line: { type: 'string', description: 'The PowerShell command line to run.' },
        timeoutMs: { type: 'number', description: 'Max run time in ms (default 120000, max 600000).' },
      },
      required: ['device', 'line'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a program directly (no shell) with arguments, as SYSTEM. Returns stdout, stderr and exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        device: DEVICE,
        program: { type: 'string', description: 'Executable to run, e.g. msiexec.exe.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments.' },
        cwd: { type: 'string', description: 'Working directory (optional).' },
        timeoutMs: { type: 'number' },
      },
      required: ['device', 'program'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the device. Returns its bytes base64-encoded (and decoded text when it is UTF-8). Capped at 512 KB; use run_powershell (Compress-Archive) for larger files.',
    inputSchema: { type: 'object', properties: { device: DEVICE, path: { type: 'string' } }, required: ['device', 'path'] },
  },
  {
    name: 'write_file',
    description: 'Write a file on the device. Provide either text, or base64 bytes in dataB64.',
    inputSchema: {
      type: 'object',
      properties: {
        device: DEVICE,
        path: { type: 'string' },
        text: { type: 'string', description: 'UTF-8 text to write.' },
        dataB64: { type: 'string', description: 'Base64 bytes to write (overrides text).' },
      },
      required: ['device', 'path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List a directory on the device. An empty path lists the drive letters.',
    inputSchema: { type: 'object', properties: { device: DEVICE, path: { type: 'string' } }, required: ['device'] },
  },
  {
    name: 'delete_path',
    description: 'Send a file or folder on the device to the Recycle Bin (recoverable).',
    inputSchema: { type: 'object', properties: { device: DEVICE, path: { type: 'string' } }, required: ['device', 'path'] },
  },
  {
    name: 'machine_info',
    description: 'Basic facts about the device (hostname, OS, agent version).',
    inputSchema: { type: 'object', properties: { device: DEVICE }, required: ['device'] },
  },
  {
    name: 'get_result',
    description: 'Fetch the result of a long-running command that returned a pending id.',
    inputSchema: { type: 'object', properties: { device: DEVICE, id: { type: 'string' } }, required: ['device', 'id'] },
  },
]

// toB64 encodes UTF-8 text to base64 for write_file's `text` convenience.
function toB64(text) {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function callTool(env, fs, rec, name, args = {}) {
  switch (name) {
    case 'list_devices':
      return listDevices(env, fs, rec)
    case 'run_powershell':
      return run(env, fs, rec, 'exec', { device: args.device, shell: 'powershell', line: args.line, timeoutMs: args.timeoutMs })
    case 'run_command':
      return run(env, fs, rec, 'exec', { device: args.device, program: args.program, args: args.args, cwd: args.cwd, timeoutMs: args.timeoutMs })
    case 'read_file':
      return run(env, fs, rec, 'read', { device: args.device, path: args.path })
    case 'write_file':
      return run(env, fs, rec, 'write', { device: args.device, path: args.path, dataB64: args.dataB64 || toB64(args.text || '') })
    case 'list_dir':
      return run(env, fs, rec, 'list', { device: args.device, path: args.path })
    case 'delete_path':
      return run(env, fs, rec, 'delete', { device: args.device, path: args.path })
    case 'machine_info':
      return run(env, fs, rec, 'info', { device: args.device })
    case 'get_result':
      return fetchResult(env, fs, rec, args.device, args.id)
    default:
      throw new ScopeError(`unknown tool: ${name}`)
  }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

// handleOne processes a single JSON-RPC message, returning a response object or
// null for a notification (which gets no reply).
async function handleOne(msg, env, fs, rec) {
  const { id, method, params } = msg || {}
  if (id === undefined || id === null) {
    // A notification (e.g. notifications/initialized): acknowledge with no body.
    return null
  }
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER,
      })
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS })
    case 'tools/call': {
      const name = params?.name
      try {
        const out = await callTool(env, fs, rec, name, params?.arguments || {})
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
      } catch (e) {
        // Tool errors are reported inside the result (isError) per MCP, so the model
        // sees them rather than the whole call failing.
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true })
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`)
  }
}

export async function handleMcp(body, env, fs, rec) {
  if (Array.isArray(body)) {
    const out = []
    for (const m of body) {
      const r = await handleOne(m, env, fs, rec)
      if (r) out.push(r)
    }
    return out.length ? out : null
  }
  return handleOne(body, env, fs, rec)
}
