// projectBV Agent API — a Cloudflare Worker that lets an AI drive the fleet with
// an API key. It is the ONLY place besides the device binary that holds the signing
// secret (AGENTAPI_TOKEN): an AI presents an API key, the Worker checks its scope,
// signs a command, and bridges the sealed result back. The AI never sees the signing
// secret or Firebase.
//
// Surfaces:
//   POST /mcp (or /mcp/<ak_live_...>)   MCP server — add as a custom connector in Claude
//   GET  /v1/devices                    REST — list reachable devices
//   POST /v1/{exec,read,write,list,delete,info}   REST — act on a device
//   GET  /v1/result?device=&id=         REST — fetch a pending long-running result
//   /admin/keys, /admin/audit           operator-only (ADMIN_TOKEN), used by the dashboard

import { Firestore } from './firestore.js'
import { resolveKey, touchKey, mintKey, listKeys, revokeKey, revokeAll, listAudit } from './keys.js'
import { run, fetchResult, listDevices, ScopeError } from './ops.js'
import { handleMcp } from './mcp.js'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Max-Age': '86400',
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })

// bearer pulls the token from the Authorization header or a ?key= fallback.
function bearer(request, url) {
  const h = request.headers.get('Authorization') || ''
  if (h.startsWith('Bearer ')) return h.slice(7).trim()
  return url.searchParams.get('key') || ''
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (path === '/') {
      return json({ service: 'projectBV Agent API', mcp: '/mcp', rest: '/v1', ok: true })
    }

    const fs = new Firestore(env.FIREBASE_PROJECT_ID, env.FIREBASE_API_KEY)

    try {
      // ---- MCP (key may be in the path so a connector needs no header config) ----
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        if (request.method !== 'POST') return json({ error: 'POST JSON-RPC to this endpoint' }, 405)
        const pathKey = path.startsWith('/mcp/') ? decodeURIComponent(path.slice(5)) : ''
        const rec = await resolveKey(env, pathKey || bearer(request, url))
        if (!rec) return json({ error: 'invalid or missing API key' }, 401)
        touchKey(env, rec) // best-effort, fire and forget
        const body = await request.json().catch(() => null)
        if (!body) return json({ error: 'invalid JSON-RPC body' }, 400)
        const res = await handleMcp(body, env, fs, rec)
        return res === null ? new Response(null, { status: 204, headers: CORS }) : json(res)
      }

      // ---- Admin (operator only) ----
      if (path.startsWith('/admin/')) {
        if (!env.ADMIN_TOKEN || bearer(request, url) !== env.ADMIN_TOKEN) {
          return json({ error: 'admin token required' }, 401)
        }
        return adminRoute(path, request, url, env)
      }

      // ---- REST v1 (API key) ----
      if (path.startsWith('/v1/')) {
        const rec = await resolveKey(env, bearer(request, url))
        if (!rec) return json({ error: 'invalid or missing API key' }, 401)
        touchKey(env, rec)
        return restRoute(path.slice(4), request, url, env, fs, rec)
      }

      return json({ error: 'not found' }, 404)
    } catch (e) {
      if (e instanceof ScopeError) return json({ ok: false, error: e.message }, 403)
      return json({ ok: false, error: e.message || String(e) }, 500)
    }
  },
}

async function restRoute(action, request, url, env, fs, rec) {
  if (action === 'devices' && request.method === 'GET') {
    return json({ ok: true, devices: await listDevices(env, fs, rec) })
  }
  if (action === 'result') {
    const device = url.searchParams.get('device')
    const id = url.searchParams.get('id')
    if (!device || !id) return json({ ok: false, error: 'device and id are required' }, 400)
    return json(await fetchResult(env, fs, rec, device, id))
  }
  if (['exec', 'read', 'write', 'list', 'delete', 'info'].includes(action)) {
    if (request.method !== 'POST') return json({ error: 'use POST' }, 405)
    const args = await request.json().catch(() => ({}))
    return json(await run(env, fs, rec, action, args))
  }
  return json({ error: 'unknown action' }, 404)
}

async function adminRoute(path, request, url, env) {
  if (path === '/admin/keys') {
    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({}))
      const { key, record } = await mintKey(env, {
        label: body.label,
        devices: body.devices,
        caps: body.caps,
        expiresAt: body.expiresAt,
      })
      // The plaintext key is returned exactly once, here.
      return json({ ok: true, key, record })
    }
    if (request.method === 'GET') return json({ ok: true, keys: await listKeys(env) })
    if (request.method === 'DELETE') {
      if (url.searchParams.get('all') === 'true') {
        return json({ ok: true, revoked: await revokeAll(env) })
      }
      const id = url.searchParams.get('id')
      if (!id) return json({ ok: false, error: 'id required' }, 400)
      return json({ ok: await revokeKey(env, id) })
    }
  }
  if (path === '/admin/audit' && request.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500)
    return json({ ok: true, audit: await listAudit(env, limit) })
  }
  return json({ error: 'unknown admin route' }, 404)
}
