import { useEffect, useState } from 'react'
import { CMD } from './protocol'
import { runCommand, setEnabled } from './data'
import { installOnDevice, cancelInstallOnDevice, agentReady, AGENT } from './deploy'
import { c, ago } from '../../ui'
import { LivePanel } from './LivePanel'

const TABS = [
  { key: 'live', label: 'Live screen' },
  { key: 'apps', label: 'Apps' },
  { key: 'tabs', label: 'Chrome tabs' },
  { key: 'message', label: 'Message' },
]

export function DevicePanel({ device, queued = null, onChanged }) {
  const [tab, setTab] = useState('live')
  const [ping, setPing] = useState(null)
  const [pinging, setPinging] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // The agent switches on/off instantly, but its heartbeat status lags ~30s — reflect
  // the change immediately so Enable/Disable feels responsive.
  const [enabledOverride, setEnabledOverride] = useState(null)
  const isEnabled = enabledOverride !== null ? enabledOverride : device.enabled

  // Close the ⋯ menu on any click elsewhere (including a tab switch) — otherwise it
  // hangs open over the content until you re-click ⋯. Deferred a tick so the click
  // that opened it doesn't immediately close it again.
  useEffect(() => {
    if (!menuOpen) return undefined
    const close = () => setMenuOpen(false)
    const t = setTimeout(() => document.addEventListener('click', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('click', close) }
  }, [menuOpen])

  async function doPing() {
    setPinging(true); setPing(null)
    try { const r = await runCommand(device.id, CMD.PING, {}, 10000); setPing({ ok: r.ok, text: `${r.output} · ${ago(r.ts)}` }) }
    catch (e) { setPing({ ok: false, text: e.message }) }
    setPinging(false)
  }
  async function reboot() {
    if (!window.confirm(`Reboot ${device.name}? It restarts in ~5 seconds and drops offline until it's back.`)) return
    try { await runCommand(device.id, CMD.REBOOT, {}, 10000); setPing({ ok: true, text: 'reboot command sent' }) }
    catch (e) { setPing({ ok: false, text: e.message }) }
  }
  // Enabling is just a switch in Firebase, so it works whatever the agent is doing —
  // before it is installed, while it is offline, any time. The agent reads the switch
  // the moment it comes up.
  async function toggleEnabled(on) {
    setMenuOpen(false)
    setEnabledOverride(on) // reflect immediately
    try { await setEnabled(device.id, on) } catch (e) { setEnabledOverride(null); setPing({ ok: false, text: e.message }) }
  }

  const status = !device.hasAgent
    ? (queued ? 'install queued — the device picks it up at its next check-in' : 'Remote not installed on this device')
    : device.agentOnline ? `agent online · ${isEnabled ? 'enabled' : 'switched off'}` : `agent offline · last seen ${ago(device.agentLastSeen)}`

  return (
    <>
      <section style={{ ...c.panel, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={c.h2}>{device.name}</h2>
            <p style={{ ...c.sub, margin: '4px 0 0' }}>
              <span style={c.dot(device.agentOnline)} />
              {status}
              {device.fleetOnline ? '  ·  device powered on' : ''}
            </p>
          </div>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {ping && <span style={{ fontSize: 12, color: ping.ok ? 'var(--ok)' : '#ff5c5c', overflowWrap: 'anywhere' }}>{ping.ok ? '✓ ' : '✕ '}{ping.text}</span>}
            {/* Always available: a device can be switched on before its agent arrives. */}
            <button
              style={{ ...(isEnabled ? c.ghost : c.primary), padding: '9px 16px', minWidth: 138, fontWeight: 650 }}
              onClick={() => toggleEnabled(!isEnabled)}>
              {isEnabled ? 'Disable control' : 'Enable control'}
            </button>
            <button style={{ ...c.ghost, opacity: device.agentOnline && !pinging ? 1 : 0.5 }} disabled={!device.agentOnline || pinging} onClick={doPing}>{pinging ? 'Pinging…' : 'Ping'}</button>
            <button style={{ ...c.ghost, padding: '8px 12px' }} onClick={() => setMenuOpen((v) => !v)} aria-label="More actions">⋯</button>
            {menuOpen && (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 6, zIndex: 10, minWidth: 170, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                <button onClick={() => { setMenuOpen(false); reboot() }} disabled={!device.agentOnline || !isEnabled}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 0, color: '#ff5c5c', padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13, opacity: device.agentOnline && isEnabled ? 1 : 0.5 }}>
                  Reboot device
                </button>
              </div>
            )}
          </div>
        </div>
        {isEnabled && !device.agentOnline && (
          <p style={{ ...c.sub, margin: '10px 0 0', fontSize: 12 }}>Switched on. It takes effect the moment this device's agent checks in.</p>
        )}
      </section>

      {!device.hasAgent ? (
        <InstallOnDevice device={device} queued={queued} onChanged={onChanged} />
      ) : !device.agentOnline ? (
        <div style={c.empty}>The agent on this device is offline — actions are unavailable until it checks back in.</div>
      ) : !isEnabled ? (
        <section style={c.panel}>
          <h2 style={c.h2}>Switched off</h2>
          <p style={c.sub}>Dormant here. Use <strong>Enable control</strong> above to take over.</p>
        </section>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)}
                style={{ background: tab === t.key ? 'var(--panel2)' : 'transparent', color: tab === t.key ? 'var(--text)' : 'var(--dim)', border: `1px solid ${tab === t.key ? 'var(--dim)' : 'var(--line)'}`, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', fontSize: 13, fontWeight: tab === t.key ? 650 : 400 }}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'live' && <LivePanel device={device} />}
          {tab === 'apps' && <AppsPanel device={device} />}
          {tab === 'tabs' && <TabsPanel device={device} />}
          {tab === 'message' && <MessagePanel device={device} />}
        </>
      )}
    </>
  )
}

// Installing Remote on ONE device. Same mechanism as the fleet-wide install, just
// addressed to this device: the entry names it as its only target, so no other
// device touches it. The install itself needs no admin rights and shows the person
// using the device nothing at all.
function InstallOnDevice({ device, queued, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const ready = agentReady()

  async function install() {
    setBusy(true); setErr(null)
    try { await installOnDevice(device.id); if (onChanged) onChanged() } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  async function cancel() {
    setBusy(true); setErr(null)
    try { await cancelInstallOnDevice(device.id) } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  return (
    <section style={c.panel}>
      <h2 style={c.h2}>Remote isn't installed on {device.name} yet</h2>
      {queued ? (
        <>
          <p style={c.sub}>Queued for this device — it installs silently at its next check-in (up to 30 minutes) and appears here when it does.</p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button style={{ ...c.primary, opacity: busy || !ready ? 0.5 : 1 }} disabled={busy || !ready} onClick={install}>Send it again</button>
            <button style={c.ghost} disabled={busy} onClick={cancel}>Cancel this install</button>
          </div>
        </>
      ) : (
        <>
          <p style={c.sub}>Installs silently, dormant until you enable control above.</p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button style={{ ...c.primary, opacity: busy || !ready ? 0.5 : 1 }} disabled={busy || !ready} onClick={install}>
              {busy ? 'Sending…' : `Install Remote on ${device.name}`}
            </button>
            {!ready && <span style={{ fontSize: 12, color: 'var(--dim)' }}>No installer published yet — run the "Build Remote agent installer" action first.</span>}
          </div>
        </>
      )}
      {err && <div style={{ color: '#ff5c5c', fontSize: 13, marginTop: 10 }}>{err}</div>}
      {!device.fleetOnline && <p style={{ ...c.sub, margin: '12px 0 0', fontSize: 12 }}>Powered off — it picks the install up when it is next on.</p>}
    </section>
  )
}

function MessagePanel({ device }) {
  const [text, setText] = useState('')
  const [secs, setSecs] = useState(5)
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  async function send() {
    if (!text.trim()) { setStatus({ ok: false, text: 'Type a message first.' }); return }
    setBusy(true); setStatus(null)
    try { const r = await runCommand(device.id, CMD.POPUP, { text, seconds: Number(secs) || 5 }); setStatus(r.ok ? { ok: true, text: `Shown on their screen for ${r.output?.seconds ?? secs}s.` } : { ok: false, text: String(r.output) }) }
    catch (e) { setStatus({ ok: false, text: e.message }) }
    setBusy(false)
  }
  return (
    <section style={c.panel}>
      <h2 style={c.h2}>Send an on-screen message</h2>
      <p style={c.sub}>A small window pops up on the device for the time you set.</p>
      <label style={c.label}>Message</label>
      <textarea style={{ ...c.input, minHeight: 80, resize: 'vertical', marginBottom: 14 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Anything you want them to see…" />
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ width: 160 }}>
          <label style={c.label}>Show for (seconds)</label>
          <input style={c.input} type="number" min={1} max={120} value={secs} onChange={(e) => setSecs(e.target.value)} />
        </div>
        <button style={{ ...c.primary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Send message'}</button>
        {status && <span style={{ fontSize: 13, color: status.ok ? 'var(--ok)' : '#ff5c5c', overflowWrap: 'anywhere' }}>{status.text}</span>}
      </div>
    </section>
  )
}

function AppsPanel({ device }) {
  const [procs, setProcs] = useState(null)
  const [apps, setApps] = useState(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState(null)
  const [launched, setLaunched] = useState(null)
  const [pFilter, setPFilter] = useState('')
  const [aFilter, setAFilter] = useState('')

  async function loadProcs() { setBusy('procs'); setErr(null); try { const r = await runCommand(device.id, CMD.LIST_PROCS, {}, 20000); setProcs(r.output || []) } catch (e) { setErr(e.message) } setBusy('') }
  async function loadApps() { setBusy('apps'); setErr(null); try { const r = await runCommand(device.id, CMD.LIST_APPS, {}, 20000); setApps(r.output || []) } catch (e) { setErr(e.message) } setBusy('') }
  async function kill(p) {
    if (!window.confirm(`Force-close “${p.name}” (PID ${p.pid}) on ${device.name}? It ends immediately.`)) return
    setErr(null)
    try { await runCommand(device.id, CMD.KILL_PROC, { pid: p.pid }); loadProcs() } catch (e) { setErr('Could not close it: ' + e.message) }
  }
  async function launch(path) { setErr(null); setLaunched(null); try { const r = await runCommand(device.id, CMD.LAUNCH_APP, { path }); setLaunched(r.output?.launched || 'app') } catch (e) { setErr('Could not launch it: ' + e.message) } }
  useEffect(() => { loadProcs() }, [device.id])

  const shownProcs = (procs || []).filter((p) => p.name.toLowerCase().includes(pFilter.toLowerCase()))
  const shownApps = (apps || []).filter((a) => a.name.toLowerCase().includes(aFilter.toLowerCase()))

  return (
    <>
      {err && <div style={{ color: '#ff5c5c', fontSize: 13, marginBottom: 12 }}>{err}</div>}
      <section style={c.panel}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
          <h2 style={c.h2}>Running now</h2>
          <button style={{ ...c.ghost, fontSize: 12 }} disabled={busy === 'procs'} onClick={loadProcs}>{busy === 'procs' ? 'Loading…' : 'Refresh'}</button>
        </div>
        <input style={{ ...c.input, marginBottom: 12 }} placeholder="Filter running processes…" value={pFilter} onChange={(e) => setPFilter(e.target.value)} />
        {procs === null ? <div style={c.empty}>Loading…</div> : shownProcs.length === 0 ? <div style={c.empty}>Nothing matches.</div> : (
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr><th style={c.th}>Process</th><th style={c.th}>Memory</th><th style={c.th}></th></tr></thead>
              <tbody>
                {shownProcs.map((p) => (
                  <tr key={p.pid}>
                    <td style={{ ...c.td, fontWeight: 600 }}>{p.name}<span style={{ color: 'var(--dim)', fontWeight: 400 }}> · {p.pid}</span></td>
                    <td style={c.td}>{(p.memKB / 1024).toFixed(0)} MB</td>
                    <td style={{ ...c.td, textAlign: 'right' }}><button onClick={() => kill(p)} style={{ background: 'none', border: '1px solid var(--line)', color: '#ff5c5c', borderRadius: 7, padding: '4px 9px', cursor: 'pointer', fontSize: 12 }}>Close</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={c.panel}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
          <h2 style={c.h2}>Installed apps</h2>
          <button style={{ ...c.ghost, fontSize: 12 }} disabled={busy === 'apps'} onClick={loadApps}>{busy === 'apps' ? 'Loading…' : apps === null ? 'Load list' : 'Refresh'}</button>
        </div>
        {launched && <div style={{ fontSize: 12, color: 'var(--ok)', marginBottom: 10 }}>✓ Launched {launched} on {device.name}.</div>}
        {apps === null ? <div style={c.empty}>Load the list to launch apps that aren't running.</div> : (
          <>
            <input style={{ ...c.input, marginBottom: 12 }} placeholder="Filter installed apps…" value={aFilter} onChange={(e) => setAFilter(e.target.value)} />
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {shownApps.length === 0 ? <div style={c.empty}>Nothing matches.</div> : shownApps.map((a) => (
                <div key={a.path} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                  <span style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{a.name}</span>
                  <button onClick={() => launch(a.path)} style={{ ...c.ghost, fontSize: 12, whiteSpace: 'nowrap' }}>Launch</button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  )
}

function TabsPanel({ device }) {
  const [state, setState] = useState(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  async function load() { setBusy(true); setErr(null); try { const r = await runCommand(device.id, CMD.LIST_TABS, {}); setState(r.output) } catch (e) { setErr(e.message) } setBusy(false) }
  async function enable() { setBusy(true); setErr(null); try { await runCommand(device.id, CMD.ENABLE_TABS, {}, 20000); await load() } catch (e) { setErr(e.message) } setBusy(false) }
  async function open() { if (!url.trim()) return; setErr(null); try { await runCommand(device.id, CMD.OPEN_TAB, { url }); setUrl(''); load() } catch (e) { setErr(e.message) } }
  async function close(id) { setErr(null); try { await runCommand(device.id, CMD.CLOSE_TAB, { targetId: id }); load() } catch (e) { setErr(e.message) } }
  useEffect(() => { load() }, [device.id])

  return (
    <section style={c.panel}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
        <h2 style={c.h2}>Chrome tabs</h2>
        <button style={{ ...c.ghost, fontSize: 12 }} disabled={busy} onClick={load}>{busy ? 'Working…' : 'Refresh'}</button>
      </div>
      {err && <div style={{ color: '#ff5c5c', fontSize: 13, marginBottom: 10 }}>{err}</div>}
      {state && state.needsEnable ? (
        <div>
          <p style={c.sub}>Chrome isn't in remote-control mode on this device. Enabling it restarts Chrome once (their tabs are restored).</p>
          <button style={{ ...c.primary, opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={enable}>Enable tab control (restarts Chrome)</button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <input style={c.input} placeholder="Open a URL, e.g. github.com" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && open()} />
            <button style={{ ...c.primary, whiteSpace: 'nowrap' }} onClick={open}>Open tab</button>
          </div>
          {state === null ? <div style={c.empty}>Loading…</div> : state.tabs.length === 0 ? <div style={c.empty}>No open tabs.</div> : (
            <div style={{ maxHeight: 340, overflowY: 'auto' }}>
              {state.tabs.map((t) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                    <div style={{ fontSize: 11, color: 'var(--dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.url}</div>
                  </div>
                  <button onClick={() => close(t.id)} style={{ background: 'none', border: '1px solid var(--line)', color: '#ff5c5c', borderRadius: 7, padding: '4px 9px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>Close</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
