// Client for the Agent API Worker's operator-only endpoints (minting keys, reading
// the audit log). The admin token is a Worker secret; the operator pastes it + the
// Worker URL once and they live in localStorage — never in the shipped bundle.

const LS_KEY = 'projectbv.agentapi.settings'

export function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* private window / blocked storage */ }
  return { base: '', adminToken: '' }
}

export function saveSettings(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)) } catch { /* ignore */ }
}

function normBase(base) {
  return String(base || '').trim().replace(/\/+$/, '')
}

async function adminFetch(settings, path, opts = {}) {
  const base = normBase(settings.base)
  if (!base) throw new Error('Set the Worker URL first.')
  if (!settings.adminToken) throw new Error('Set the admin token first.')
  const r = await fetch(base + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${settings.adminToken}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error || `Worker HTTP ${r.status}`)
  return body
}

export const listKeys = (s) => adminFetch(s, '/admin/keys').then((b) => b.keys || [])
export const mintKey = (s, spec) => adminFetch(s, '/admin/keys', { method: 'POST', body: JSON.stringify(spec) })
export const revokeKey = (s, id) => adminFetch(s, `/admin/keys?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
export const revokeAllKeys = (s) => adminFetch(s, '/admin/keys?all=true', { method: 'DELETE' })
export const listAudit = (s, limit = 100) => adminFetch(s, `/admin/audit?limit=${limit}`).then((b) => b.audit || [])

// The URL to paste into Claude as a custom MCP connector (key embedded so no header
// config is needed).
export function connectorUrl(base, key) {
  return `${normBase(base)}/mcp/${key}`
}
