import { useEffect, useState } from 'react'
import { loadDevices, setEnabled } from './data'
import { LivePanel } from './LivePanel'
import { usePersistentSelection } from '../../persist'
import { c, ago } from '../../ui'

// The Logger tool: pick a fleet device, switch Logger on for it, then watch it live
// — screen, speaker output, microphone, and the real keyboard/mouse in use. It
// controls nothing and stores nothing.
export default function LoggerPage() {
  const [devices, setDevices] = useState([])
  const [selected, setSelected] = usePersistentSelection('device')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try { setDevices(await loadDevices()); setErr(null) }
    catch (e) { setErr('Cannot reach Firebase: ' + e.message) }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 6000); return () => clearInterval(t) }, [])

  const device = devices.find((d) => d.id === selected) || null
  const online = devices.filter((d) => d.agentOnline).length

  async function toggle(on) {
    if (!device) return
    setBusy(true)
    try { await setEnabled(device.id, on); await refresh() } finally { setBusy(false) }
  }

  return (
    <div className="tool-grid">
      <aside>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={c.h2}>Fleet devices</h2>
          {devices.length > 0 && <span style={{ fontSize: 12, color: 'var(--dim)' }}>{online} online / {devices.length}</span>}
        </div>
        {err && <div style={{ color: 'var(--bad)', fontSize: 13, marginBottom: 10 }}>{err}</div>}
        {devices.length === 0 ? (
          <div style={c.empty}>No devices yet.</div>
        ) : devices.map((d) => {
          const on = selected === d.id
          const label = !d.hasAgent
            ? 'needs agent update'
            : d.agentOnline ? `online · ${d.enabled ? 'on' : 'off'}` : `agent offline · ${ago(d.agentLastSeen)}`
          return (
            <button key={d.id} onClick={() => setSelected(d.id)}
              style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, cursor: 'pointer', background: on ? 'var(--panel2)' : 'transparent', border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`, color: 'var(--text)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{d.name}</div>
              <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 3 }}><span style={c.dot(d.agentOnline)} />{label}</div>
            </button>
          )
        })}
      </aside>

      <main style={{ minWidth: 0 }}>
        {!device ? (
          <div style={{ ...c.empty, marginTop: 40 }}>Pick a device on the left to watch it.</div>
        ) : !device.hasAgent ? (
          <div style={c.panel}>
            <h2 style={c.h2}>{device.name}</h2>
            <p style={{ ...c.sub, marginTop: 8 }}>This device's agent doesn't include Logger yet. Push the latest BV Remote agent to it from the Remote tool, then it appears here.</p>
          </div>
        ) : (
          <>
            <section style={{ ...c.panel, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <h2 style={{ ...c.h2 }}>{device.name}</h2>
                <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 4 }}>
                  <span style={c.dot(device.agentOnline)} />{device.agentOnline ? 'agent online' : `agent offline · ${ago(device.agentLastSeen)}`}{device.version ? ` · v${device.version}` : ''}
                </div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" disabled={busy} checked={device.enabled} onChange={(e) => toggle(e.target.checked)} />
                Logger {device.enabled ? 'on' : 'off'} for this device
              </label>
            </section>

            {device.enabled
              ? <LivePanel key={device.id} device={device} />
              : <div style={c.empty}>Switch Logger on for this device to watch it.</div>}
          </>
        )}
      </main>
    </div>
  )
}
