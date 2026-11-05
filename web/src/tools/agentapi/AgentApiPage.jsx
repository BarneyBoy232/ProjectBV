import { useEffect, useMemo, useState } from 'react'
import { loadDevices, setArmed } from './devices'
import { loadSettings, saveSettings, listKeys, mintKey, revokeKey, revokeAllKeys, listAudit, connectorUrl } from './worker'
import { c, ago } from '../../ui'

// One page, four panels: connect the Worker, arm devices, mint/revoke keys, watch
// the audit log. No explainer copy — single operator.
export default function AgentApiPage() {
  const [settings, setSettings] = useState(loadSettings)
  const connected = !!(settings.base && settings.adminToken)

  return (
    <div style={{ maxWidth: 1080 }}>
      <WorkerPanel settings={settings} onSave={(s) => { saveSettings(s); setSettings(s) }} />
      <DevicesPanel />
      {connected
        ? <><KeysPanel settings={settings} /><AuditPanel settings={settings} /></>
        : <div style={{ ...c.panel, color: 'var(--dim)', fontSize: 13 }}>Connect the Worker above to mint keys and see the audit log.</div>}
    </div>
  )
}

// --- 1. Worker connection --------------------------------------------------
function WorkerPanel({ settings, onSave }) {
  const [base, setBase] = useState(settings.base || '')
  const [token, setToken] = useState(settings.adminToken || '')
  const [status, setStatus] = useState(null)

  async function test(next) {
    setStatus('testing')
    try { await listKeys(next); setStatus('ok') }
    catch (e) { setStatus(e.message) }
  }

  return (
    <div style={c.panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={c.h2}>Agent API Worker</h2>
        <span style={{ fontSize: 12, color: status === 'ok' ? 'var(--ok)' : status && status !== 'testing' ? 'var(--bad)' : 'var(--dim)' }}>
          {status === 'ok' ? 'connected' : status === 'testing' ? 'testing…' : status || ''}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
        <div>
          <label style={c.label}>Worker URL</label>
          <input style={c.input} placeholder="https://projectbv-agent-api.you.workers.dev" value={base} onChange={(e) => setBase(e.target.value)} />
        </div>
        <div>
          <label style={c.label}>Admin token</label>
          <input style={c.input} type="password" placeholder="the ADMIN_TOKEN secret you set on the Worker" value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={c.primary} onClick={() => { const s = { base: base.trim(), adminToken: token.trim() }; onSave(s); test(s) }}>Save &amp; test</button>
        </div>
      </div>
    </div>
  )
}

// --- 2. Arming devices -----------------------------------------------------
function DevicesPanel() {
  const [devices, setDevices] = useState([])
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState('')
  const [armFor, setArmFor] = useState(3600000) // default: arm for 1 hour

  async function refresh() {
    try { setDevices(await loadDevices()); setErr(null) }
    catch (e) { setErr(e.message) }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t) }, [])

  async function toggle(d) {
    // Arming is the one action that hands an AI the ability to run anything on a live
    // device, so it is the one that gets a confirm — disarming stays instant.
    if (!d.armed) {
      const how = armFor === 0 ? 'with no expiry (until you disarm it)' : `for ${durationLabel(armFor)}`
      if (!confirm(`Arm ${d.name} ${how}?\n\nWhile armed, Claude (or any AI holding a valid key scoped to this device) can run commands on it — including as administrator — whether you are watching or not. Disarming is instant.`)) return
    }
    setBusy(d.id)
    try { await setArmed(d.id, !d.armed, armFor); await refresh() }
    catch (e) { setErr(e.message) }
    finally { setBusy('') }
  }

  async function disarmAll() {
    const armed = devices.filter((d) => d.armed)
    if (!armed.length) return
    if (!confirm(`Disarm all ${armed.length} armed device(s) now? The AI is immediately unable to act on any of them.`)) return
    setBusy('__all__')
    try { for (const d of armed) await setArmed(d.id, false); await refresh() }
    catch (e) { setErr(e.message) }
    finally { setBusy('') }
  }

  const armedCount = devices.filter((d) => d.armed).length

  return (
    <div style={c.panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h2 style={c.h2}>Devices the AI may control</h2>
        <span style={{ fontSize: 12, color: armedCount ? 'var(--accent)' : 'var(--dim)' }}>{armedCount} armed / {devices.length}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '10px 0 4px' }}>
        <span style={{ fontSize: 12, color: 'var(--dim)' }}>Arm for</span>
        <select style={{ ...c.input, width: 'auto' }} value={armFor} onChange={(e) => setArmFor(Number(e.target.value))}>
          {DURATIONS.map((o) => <option key={o.ms} value={o.ms}>{o.label}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        {armedCount > 0 && (
          <button style={{ ...c.ghost, borderColor: 'var(--bad)', color: 'var(--bad)' }} disabled={busy === '__all__'} onClick={disarmAll}>
            {busy === '__all__' ? 'Disarming…' : `Disarm all (${armedCount})`}
          </button>
        )}
      </div>
      {err && <div style={{ color: 'var(--bad)', fontSize: 13, margin: '8px 0' }}>{err}</div>}
      {devices.length === 0 && <div style={c.empty}>No devices yet.</div>}
      <div style={{ marginTop: 8 }}>
        {devices.map((d) => {
          const state = !d.hasAgent ? 'needs agent update'
            : !d.agentOnline ? `offline · ${ago(d.agentLastSeen)}`
            : d.armed ? 'armed — AI can act' : 'disarmed'
          return (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{d.name}</div>
                <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 2 }}><span style={c.dot(d.agentOnline && d.armed)} />{state}</div>
              </div>
              <button
                style={d.armed
                  ? { ...c.ghost, borderColor: 'var(--bad)', color: 'var(--bad)' }
                  : c.ghost}
                disabled={!d.hasAgent || busy === d.id}
                onClick={() => toggle(d)}>
                {busy === d.id ? '…' : d.armed ? 'Disarm' : 'Arm'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// --- 3. Keys ---------------------------------------------------------------
function KeysPanel({ settings }) {
  const [keys, setKeys] = useState([])
  const [err, setErr] = useState(null)
  const [minted, setMinted] = useState(null) // { key, record } shown once
  const [devices, setDevices] = useState([])

  const [label, setLabel] = useState('claude')
  const [scope, setScope] = useState('all') // 'all' | 'pick'
  const [picked, setPicked] = useState(() => new Set())
  const [caps, setCaps] = useState('full')
  const [days, setDays] = useState('')

  async function refresh() {
    try { setKeys(await listKeys(settings)); setErr(null) }
    catch (e) { setErr(e.message) }
  }
  useEffect(() => { refresh(); loadDevices().then(setDevices).catch(() => {}) }, []) // eslint-disable-line

  async function doMint() {
    setErr(null)
    try {
      const spec = {
        label: label.trim() || 'unnamed',
        devices: scope === 'all' ? 'all' : [...picked],
        caps,
        expiresAt: days ? Date.now() + Number(days) * 86400000 : 0,
      }
      const res = await mintKey(settings, spec)
      setMinted(res)
      refresh()
    } catch (e) { setErr(e.message) }
  }

  async function doRevoke(id) {
    if (!confirm('Revoke this key? Any AI using it is cut off immediately.')) return
    try { await revokeKey(settings, id); refresh() } catch (e) { setErr(e.message) }
  }

  async function doRevokeAll() {
    if (!confirm('Revoke ALL keys now? Every AI using any key is cut off immediately, and you will need to mint new keys afterwards.')) return
    try { await revokeAllKeys(settings); refresh() } catch (e) { setErr(e.message) }
  }

  return (
    <div style={c.panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={c.h2}>API keys</h2>
        {keys.length > 0 && <button style={{ ...c.ghost, borderColor: 'var(--bad)', color: 'var(--bad)', fontSize: 12, padding: '5px 10px' }} onClick={doRevokeAll}>Revoke all</button>}
      </div>
      {err && <div style={{ color: 'var(--bad)', fontSize: 13, margin: '8px 0' }}>{err}</div>}

      {minted && <MintedKey minted={minted} base={settings.base} onDismiss={() => setMinted(null)} />}

      {/* mint form */}
      <div style={{ display: 'grid', gap: 10, marginTop: 10, padding: 14, border: '1px solid var(--line)', borderRadius: 10 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 160px' }}>
            <label style={c.label}>Label</label>
            <input style={c.input} value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div>
            <label style={c.label}>Can do</label>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', paddingTop: 4 }}>
              <label style={radio}><input type="radio" checked={caps === 'full'} onChange={() => setCaps('full')} /> Everything (exec, write, delete)</label>
              <label style={radio}><input type="radio" checked={caps === 'read'} onChange={() => setCaps('read')} /> Read only (read, list, info)</label>
            </div>
          </div>
          <div>
            <label style={c.label}>Expires in (days)</label>
            <input style={{ ...c.input, width: 110 }} placeholder="never" value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ''))} />
          </div>
        </div>
        <div>
          <label style={c.label}>Devices</label>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={radio}><input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} /> All devices</label>
            <label style={radio}><input type="radio" checked={scope === 'pick'} onChange={() => setScope('pick')} /> Only these</label>
          </div>
          {scope === 'pick' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              {devices.map((d) => {
                const on = picked.has(d.id)
                return (
                  <button key={d.id} onClick={() => setPicked((p) => { const n = new Set(p); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n })}
                    style={{ ...c.ghost, padding: '5px 10px', fontSize: 12, borderColor: on ? 'var(--accent)' : 'var(--line)', color: on ? 'var(--text)' : 'var(--dim)' }}>
                    {d.name}
                  </button>
                )
              })}
              {devices.length === 0 && <span style={{ fontSize: 12, color: 'var(--dim)' }}>No devices to pick.</span>}
            </div>
          )}
        </div>
        <div><button style={c.primary} onClick={doMint} disabled={scope === 'pick' && picked.size === 0}>Mint key</button></div>
      </div>

      {/* existing keys */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 14 }}>
        <thead><tr>
          <th style={c.th}>Label</th><th style={c.th}>Scope</th><th style={c.th}>Can do</th>
          <th style={c.th}>Last used</th><th style={c.th}></th>
        </tr></thead>
        <tbody>
          {keys.length === 0 && <tr><td style={{ ...c.td, color: 'var(--dim)' }} colSpan={5}>No keys yet.</td></tr>}
          {keys.map((k) => (
            <tr key={k.id}>
              <td style={c.td}>{k.label}<div style={{ fontSize: 11, color: 'var(--dim)' }}>…{k.id}{k.expiresAt ? ` · expires ${new Date(k.expiresAt).toLocaleDateString()}` : ''}</div></td>
              <td style={c.td}>{k.devices === 'all' ? 'all devices' : `${(k.devices || []).length} device(s)`}</td>
              <td style={c.td}>{k.caps === 'read' ? 'read only' : 'everything'}</td>
              <td style={{ ...c.td, color: 'var(--dim)' }}>{k.lastUsed ? ago(k.lastUsed) : 'never'}</td>
              <td style={{ ...c.td, textAlign: 'right' }}><button style={{ ...c.ghost, borderColor: 'var(--bad)', color: 'var(--bad)', padding: '5px 10px', fontSize: 12 }} onClick={() => doRevoke(k.id)}>Revoke</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MintedKey({ minted, base, onDismiss }) {
  const url = connectorUrl(base, minted.key)
  const copy = (t) => navigator.clipboard?.writeText(t)
  return (
    <div style={{ border: '1px solid var(--accent)', background: 'var(--panel2)', borderRadius: 10, padding: 14, marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>New key — copy it now, it won't be shown again.</div>
      <Field label="API key" value={minted.key} onCopy={() => copy(minted.key)} />
      <Field label="Claude MCP connector URL" value={url} onCopy={() => copy(url)} />
      <button style={{ ...c.ghost, marginTop: 8, fontSize: 12 }} onClick={onDismiss}>Done</button>
    </div>
  )
}

function Field({ label, value, onCopy }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={c.label}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ ...c.input, fontFamily: 'monospace', fontSize: 12 }} readOnly value={value} onFocus={(e) => e.target.select()} />
        <button style={c.ghost} onClick={onCopy}>Copy</button>
      </div>
    </div>
  )
}

// --- 4. Audit --------------------------------------------------------------
function AuditPanel({ settings }) {
  const [audit, setAudit] = useState([])
  const [err, setErr] = useState(null)

  async function refresh() {
    try { setAudit(await listAudit(settings, 100)); setErr(null) }
    catch (e) { setErr(e.message) }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t) }, []) // eslint-disable-line

  return (
    <div style={c.panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={c.h2}>Audit log</h2>
        <button style={{ ...c.ghost, fontSize: 12, padding: '5px 10px' }} onClick={refresh}>Refresh</button>
      </div>
      {err && <div style={{ color: 'var(--bad)', fontSize: 13, margin: '8px 0' }}>{err}</div>}
      <div style={{ maxHeight: 360, overflowY: 'auto', marginTop: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead><tr>
          <th style={c.th}>When</th><th style={c.th}>Device</th><th style={c.th}>Action</th><th style={c.th}>Key</th><th style={c.th}>Result</th>
        </tr></thead>
        <tbody>
          {audit.length === 0 && <tr><td style={{ ...c.td, color: 'var(--dim)' }} colSpan={5}>Nothing yet.</td></tr>}
          {audit.map((a, i) => (
            <tr key={i}>
              <td style={{ ...c.td, color: 'var(--dim)', whiteSpace: 'nowrap' }}>{ago(a.ts)}</td>
              <td style={c.td}>{a.device}</td>
              <td style={c.td}>{a.summary || a.action}</td>
              <td style={{ ...c.td, color: 'var(--dim)' }}>{a.keyLabel}</td>
              <td style={c.td}>
                {a.pending ? <span style={{ color: 'var(--dim)' }}>running…</span>
                  : a.ok ? <span style={{ color: 'var(--ok)' }}>ok</span>
                  : <span style={{ color: 'var(--bad)' }}>{a.error || 'failed'}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  )
}

const radio = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }

const DURATIONS = [
  { ms: 900000, label: '15 minutes' },
  { ms: 3600000, label: '1 hour' },
  { ms: 28800000, label: '8 hours' },
  { ms: 0, label: 'No expiry' },
]
function durationLabel(ms) {
  return (DURATIONS.find((o) => o.ms === ms) || {}).label || `${Math.round(ms / 60000)} min`
}
function expiresIn(until) {
  const s = Math.max(0, Math.round((until - Date.now()) / 1000))
  if (s < 60) return `expires in ${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `expires in ${m}m`
  return `expires in ${Math.round(m / 60)}h`
}
