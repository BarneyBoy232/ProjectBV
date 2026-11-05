import { useEffect, useState } from 'react'
import { loadDevices } from './devices'
import { generateKey, listKeys, revokeKey, cutEverythingOff, listAudit } from './keys'
import { c, ago } from '../../ui'

// Generate a key, paste it into Claude Code, it controls your devices. One button,
// presets, and a single "cut everything off". No worker-connecting, no arming step.
export default function AgentApiPage() {
  const [devices, setDevices] = useState([])
  useEffect(() => { loadDevices().then(setDevices).catch(() => {}) }, [])
  const allIds = devices.map((d) => d.id)
  return (
    <div style={{ maxWidth: 760 }}>
      <KeysPanel devices={devices} allIds={allIds} />
      <AuditPanel />
    </div>
  )
}

const DURATIONS = [
  { ms: 0, label: 'No expiry' },
  { ms: 3600000, label: '1 hour' },
  { ms: 28800000, label: '8 hours' },
  { ms: 30 * 86400000, label: '30 days' },
]

function KeysPanel({ devices, allIds }) {
  const [keys, setKeys] = useState([])
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [minted, setMinted] = useState(null)

  const [label, setLabel] = useState('claude')
  const [scope, setScope] = useState('all')      // 'all' | 'pick'
  const [picked, setPicked] = useState(() => new Set())
  const [caps, setCaps] = useState('full')
  const [expiry, setExpiry] = useState(0)

  async function refresh() {
    try { setKeys(await listKeys()); setErr(null) } catch (e) { setErr(e.message) }
  }
  useEffect(() => { refresh() }, [])

  async function doGenerate() {
    setBusy(true); setErr(null)
    try {
      const res = await generateKey({
        label: label.trim() || 'claude',
        devices: scope === 'all' ? 'all' : [...picked],
        caps,
        durationMs: expiry,
      }, allIds)
      setMinted(res)
      refresh()
    } catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }

  async function doRevoke(hash) {
    if (!confirm('Revoke this key? Claude is cut off from it immediately.')) return
    try { await revokeKey(hash); refresh() } catch (e) { setErr(e.message) }
  }

  async function doCutOff() {
    if (!confirm('Cut everything off now?\n\nEvery key stops working and every device is disarmed immediately. You will generate a new key to start again.')) return
    setBusy(true)
    try { await cutEverythingOff(allIds); setMinted(null); refresh() }
    catch (e) { setErr(e.message) }
    finally { setBusy(false) }
  }

  return (
    <div style={c.panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={c.h2}>Give Claude a key</h2>
        {keys.length > 0 && (
          <button style={{ ...c.ghost, borderColor: 'var(--bad)', color: 'var(--bad)', fontWeight: 600 }} disabled={busy} onClick={doCutOff}>
            Cut everything off
          </button>
        )}
      </div>

      {err && <div style={{ color: 'var(--bad)', fontSize: 13, margin: '8px 0' }}>{err}</div>}
      {minted && <Minted minted={minted} onDismiss={() => setMinted(null)} />}

      {/* presets */}
      <div style={{ display: 'grid', gap: 12, marginTop: 12, padding: 14, border: '1px solid var(--line)', borderRadius: 10 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 160px' }}>
            <label style={c.label}>Label</label>
            <input style={c.input} value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div>
            <label style={c.label}>Can do</label>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', paddingTop: 6 }}>
              <label style={radio}><input type="radio" checked={caps === 'full'} onChange={() => setCaps('full')} /> Everything (full admin)</label>
              <label style={radio}><input type="radio" checked={caps === 'read'} onChange={() => setCaps('read')} /> Read only</label>
            </div>
          </div>
          <div>
            <label style={c.label}>Expires</label>
            <select style={{ ...c.input, width: 'auto' }} value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
              {DURATIONS.map((o) => <option key={o.ms} value={o.ms}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label style={c.label}>Devices</label>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
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
              {devices.length === 0 && <span style={{ fontSize: 12, color: 'var(--dim)' }}>No devices yet.</span>}
            </div>
          )}
        </div>
        <div>
          <button style={c.primary} disabled={busy || (scope === 'pick' && picked.size === 0)} onClick={doGenerate}>
            {busy ? 'Generating…' : 'Generate key'}
          </button>
        </div>
      </div>

      {/* existing keys */}
      {keys.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 }}>
          <thead><tr>
            <th style={c.th}>Label</th><th style={c.th}>Devices</th><th style={c.th}>Can do</th><th style={c.th}>Expires</th><th style={c.th}></th>
          </tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.hash}>
                <td style={c.td}>{k.label}<div style={{ fontSize: 11, color: 'var(--dim)' }}>…{k.id}</div></td>
                <td style={c.td}>{k.devices === 'all' ? 'all' : `${(k.devices || []).length} device(s)`}</td>
                <td style={c.td}>{k.caps === 'read' ? 'read only' : 'everything'}</td>
                <td style={{ ...c.td, color: 'var(--dim)' }}>{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'never'}</td>
                <td style={{ ...c.td, textAlign: 'right' }}><button style={{ ...c.ghost, borderColor: 'var(--bad)', color: 'var(--bad)', padding: '5px 10px', fontSize: 12 }} onClick={() => doRevoke(k.hash)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Minted({ minted, onDismiss }) {
  const copy = (t) => navigator.clipboard?.writeText(t)
  return (
    <div style={{ border: '1px solid var(--accent)', background: 'var(--panel2)', borderRadius: 10, padding: 14, marginTop: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Your key — copy it now, it won't be shown again.</div>
      <div style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 10 }}>In Claude Code: add a custom connector and paste the URL below. Claude then has this machine's tools.</div>
      <Field label="Claude Code connector URL" value={minted.connector} onCopy={() => copy(minted.connector)} />
      <Field label="Key on its own (if you need it)" value={minted.key} onCopy={() => copy(minted.key)} />
      <button style={{ ...c.ghost, marginTop: 6, fontSize: 12 }} onClick={onDismiss}>Done</button>
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

function AuditPanel() {
  const [audit, setAudit] = useState([])
  async function refresh() { try { setAudit(await listAudit(100)) } catch { /* ignore */ } }
  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t) }, [])

  return (
    <div style={c.panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2 style={c.h2}>What Claude did</h2>
        <button style={{ ...c.ghost, fontSize: 12, padding: '5px 10px' }} onClick={refresh}>Refresh</button>
      </div>
      <div style={{ maxHeight: 360, overflowY: 'auto', marginTop: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>
            <th style={c.th}>When</th><th style={c.th}>Device</th><th style={c.th}>Action</th><th style={c.th}>Result</th>
          </tr></thead>
          <tbody>
            {audit.length === 0 && <tr><td style={{ ...c.td, color: 'var(--dim)' }} colSpan={4}>Nothing yet.</td></tr>}
            {audit.map((a, i) => (
              <tr key={i}>
                <td style={{ ...c.td, color: 'var(--dim)', whiteSpace: 'nowrap' }}>{ago(a.ts)}</td>
                <td style={c.td}>{a.device}</td>
                <td style={c.td}>{a.summary || a.action}</td>
                <td style={c.td}>
                  {a.pending ? <span style={{ color: 'var(--dim)' }}>running…</span>
                    : a.ok === false ? <span style={{ color: 'var(--bad)' }}>{a.outcome || 'error'}</span>
                    : <span style={{ color: 'var(--ok)' }}>{a.outcome || 'ok'}</span>}
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
