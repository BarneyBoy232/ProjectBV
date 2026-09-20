import { useEffect, useState } from 'react'
import { listManifest, listDevices, deployApp, deployFile, removeEntry, deployAgentUpdate, setDeviceLabel, removeDevice, AGENT_NAME } from './api'
import { c, ago } from './ui'
import agentBuild from './agent-build.json'

const ONLINE_MS = 3 * 60 * 1000

export default function DeployPage() {
  const [devices, setDevices] = useState([])
  const [manifest, setManifest] = useState([])
  const [kind, setKind] = useState('app')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [silent, setSilent] = useState('')
  const [scope, setScope] = useState('machine')
  const [dest, setDest] = useState('')
  const [file, setFile] = useState(null)
  const [target, setTarget] = useState('')
  const [publishedUrl, setPublishedUrl] = useState('')
  const [renaming, setRenaming] = useState(null) // device id being renamed
  const [rename, setRename] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      const [d, m] = await Promise.all([listDevices(), listManifest()])
      setDevices(d)
      setManifest(m)
    } catch (e) {
      setMsg({ ok: false, text: 'Cannot reach Firebase: ' + e.message })
    }
  }
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 6000)
    return () => clearInterval(t)
  }, [])

  // "Fleet agent" was never a different kind of send — it is the same "put this
  // file on the devices", recognised from the file itself (or from typing the
  // agent's name), so there is no mode to choose and no way to pick the wrong one.
  const agentMode = !!file && /projectbv[-_]?key\.exe$/i.test(file.name)

  async function onRename(id) {
    await setDeviceLabel(id, rename).catch((err) => setMsg({ ok: false, text: err.message }))
    setRenaming(null)
    setRename('')
    refresh()
  }

  async function onDeploy(e) {
    e.preventDefault()
    if (!file) { setMsg({ ok: false, text: 'Choose a file first.' }); return }
    if (agentMode) {
      const where = target ? target : `all ${devices.length} devices`
      if (!confirm(`Push the fleet agent (${agentBuild.version}) to ${where}? Each restarts its agent as it updates.`)) return
    } else if (!name || !version) {
      setMsg({ ok: false, text: 'Name and version are required.' }); return
    } else if (!dest) {
      setMsg({ ok: false, text: 'A file needs a destination path.' }); return
    }
    setBusy(true); setMsg({ ok: true, text: 'Uploading…' })
    try {
      if (agentMode) {
        await deployAgentUpdate({ version: agentBuild.version, file, targets: target ? [target] : [], publishedUrl })
      } else if (kind === 'app') {
        await deployApp({ name, version, file, scope, silentArgs: silent.split(',').map((s) => s.trim()).filter(Boolean) })
      } else {
        await deployFile({ name, version, file, dest, targets: target ? [target] : [] })
      }
      setMsg({ ok: true, text: 'Deployed — devices will pull it on their next check.' })
      setName(''); setVersion(''); setSilent(''); setDest(''); setFile(null); setTarget(''); setPublishedUrl('')
      e.target.reset()
      refresh()
    } catch (err) {
      setMsg({ ok: false, text: err.message })
    }
    setBusy(false)
  }

  // Entries are removed by document id, not by app name — one app can have a
  // fleet-wide entry and a per-device one, and they must be removable separately.
  async function onRemove(entry) {
    const what = entry.targets && entry.targets.length ? `${entry.name} on ${entry.targets.join(', ')}` : entry.name
    if (!confirm(`Remove "${what}"? (already-installed devices keep it)`)) return
    await removeEntry(entry.id)
    refresh()
  }

  async function onRemoveDevice(d) {
    const label = d.display || d.name || d.id
    if (!confirm(`Remove "${label}" from the fleet? If its agent is still alive it will reappear on its next check-in.`)) return
    await removeDevice(d.id)
    refresh()
  }

  const now = Date.now()
  return (
    <>
      <section style={c.panel}>
        <h2 style={c.h2}>Connected devices</h2>
        <p style={c.sub}>Devices running the projectBV agent. Anything you deploy goes to these.</p>
        {devices.length === 0 ? (
          <div style={c.empty}>No devices yet — install the agent on a device and it appears here.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead><tr><th style={c.th}>Device</th><th style={c.th}>Version</th><th style={c.th}>Status</th></tr></thead>
            <tbody>
              {devices.map((d) => {
                const online = d.lastSeen && now - d.lastSeen < ONLINE_MS
                return (
                  <tr key={d.id || d.name}>
                    <td style={{ ...c.td, fontWeight: 600 }}>
                      {renaming === (d.id || d.name) ? (
                        <input autoFocus style={{ ...c.input, padding: '4px 8px' }} value={rename}
                          onChange={(e) => setRename(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') onRename(d.id || d.name); if (e.key === 'Escape') setRenaming(null) }}
                          onBlur={() => onRename(d.id || d.name)} />
                      ) : (
                        <span style={{ cursor: 'pointer' }} title={d.name}
                          onClick={() => { setRenaming(d.id || d.name); setRename(d.label || '') }}>
                          {d.display || d.name}
                        </span>
                      )}
                    </td>
                    <td style={c.td}>{d.version || '—'}</td>
                    <td style={c.td}>
                      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 8, marginRight: 7, background: online ? 'var(--ok)' : '#5a5f66' }} />
                      {online ? 'online' : 'offline'}
                      {!online && <span style={{ color: 'var(--dim)' }}> · last seen {ago(d.lastSeen)}</span>}
                      <UpdateOutcome device={d} />
                      {!online && (
                        <button onClick={() => onRemoveDevice(d)}
                          title="Remove this device from the list. A live agent reappears on its next check-in."
                          style={{ marginLeft: 12, background: 'none', border: '1px solid var(--line)', color: 'var(--dim)', borderRadius: 7, padding: '3px 9px', cursor: 'pointer', fontSize: 12 }}>
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section style={c.panel}>
        <h2 style={c.h2}>Send a file / app</h2>
        <div style={{ display: 'inline-flex', background: 'var(--panel2)', border: '1px solid var(--line)', borderRadius: 9, padding: 3, marginBottom: 16 }}>
          {[['app', 'App (installer)'], ['file', 'File']].map(([k, label]) => {
            // Two tabs: run an installer, or put a file on the device. The fleet
            // agent is not a third thing — it is a file, recognised from the file.
            const on = kind === k
            return (
              <button key={k} type="button" onClick={() => setKind(k)}
                style={{ background: on ? 'var(--accent)' : 'transparent', color: on ? 'var(--accent-ink)' : 'var(--dim)', border: 0, padding: '7px 16px', borderRadius: 7, cursor: 'pointer', fontWeight: on ? 600 : 400 }}>
                {label}
              </button>
            )
          })}
        </div>
        <form onSubmit={onDeploy}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {kind === 'app' ? (
              <>
                <div><label style={c.label}>Name (unique)</label><input style={c.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="AcmeTool" /></div>
                <div><label style={c.label}>Version</label><input style={c.input} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.2.0" /></div>
                <div style={{ gridColumn: '1/-1' }}><label style={c.label}>Silent install args (optional, comma-separated)</label><input style={c.input} value={silent} onChange={(e) => setSilent(e.target.value)} placeholder="/VERYSILENT, /NORESTART" /></div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={c.label}>Install as</label>
                  <select style={c.input} value={scope} onChange={(e) => setScope(e.target.value)}>
                    <option value="machine">the machine (admin rights, all users)</option>
                    <option value="user">the signed-in user (no admin; waits for someone to sign in)</option>
                  </select>
                </div>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={c.label}>File</label>
                  <input type="file" onChange={(e) => setFile(e.target.files[0])} />
                </div>
              </>
            ) : (
              <>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={c.label}>File</label>
                  <input type="file" onChange={(e) => setFile(e.target.files[0])} />
                </div>
                {!agentMode && (
                  <>
                    <div><label style={c.label}>Name (unique)</label><input style={c.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="AcmeTool" /></div>
                    <div><label style={c.label}>Version</label><input style={c.input} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.2.0" /></div>
                    <div style={{ gridColumn: '1/-1' }}><label style={c.label}>Destination path on the device</label><input style={c.input} value={dest} onChange={(e) => setDest(e.target.value)} placeholder="C:\\ProgramData\\MyApp\\config.json" /></div>
                  </>
                )}
                <div><label style={c.label}>Push to</label>
                  <select style={c.input} value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">every device</option>
                    {devices.map((d) => <option key={d.id || d.name} value={d.id || d.name}>{d.display || d.name} only</option>)}
                  </select>
                </div>
                {agentMode && (
                  <div style={{ gridColumn: '1/-1' }}>
                    <label style={c.label}>Plain .exe URL (only agents below 1.1.0 need this)</label>
                    <input style={c.input} value={publishedUrl} onChange={(e) => setPublishedUrl(e.target.value)}
                      placeholder="https://github.com/you/repo/releases/download/v1.1.0/projectBV-key.exe" />
                  </div>
                )}
              </>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <button type="submit" style={{ ...c.primary, opacity: busy ? 0.5 : 1 }} disabled={busy}>
              {agentMode ? (target ? 'Update this device' : 'Update every device') : 'Deploy'}
            </button>
            {msg && <span style={{ fontSize: 13, color: msg.ok ? 'var(--ok)' : '#ff5c5c' }}>{msg.text}</span>}
          </div>
        </form>
      </section>

      <section style={c.panel}>
        <h2 style={c.h2}>Current deployments</h2>
        <p style={c.sub}>What every device pulls. Re-deploy with a higher version to push an update.</p>
        {manifest.length === 0 ? (
          <div style={c.empty}>Nothing published yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead><tr><th style={c.th}>Name</th><th style={c.th}>Version</th><th style={c.th}>Type</th><th style={c.th}>Destination / args</th><th style={c.th}></th></tr></thead>
            <tbody>
              {manifest.map((a) => (
                <tr key={a.id}>
                  <td style={{ ...c.td, fontWeight: 600 }}>
                    {a.name}
                    <div style={{ fontSize: 11, color: 'var(--dim)', fontWeight: 400, marginTop: 2 }}>
                      {a.targets && a.targets.length ? `only: ${a.targets.join(', ')}` : 'every device'}
                    </div>
                  </td>
                  <td style={c.td}>{a.version}</td>
                  <td style={c.td}>{a.type || 'app'}</td>
                  <td style={c.td}>{a.type === 'file' ? a.dest : (a.silentArgs || []).join(' ') || '—'}</td>
                  <td style={{ ...c.td, textAlign: 'right' }}>
                    <button onClick={() => onRemove(a)} style={{ background: 'none', border: '1px solid var(--line)', color: '#ff5c5c', borderRadius: 7, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  )
}

// What the last agent update actually did on this device. Only shown when it did
// not simply work: a device that rolled back reads as "still on the old version"
// otherwise, which is indistinguishable from one that never got the update.
function UpdateOutcome({ device }) {
  const result = device.lastUpdateResult
  if (!result || result === 'installed') return null
  const failed = result === 'rollback-failed'
  return (
    <div style={{ fontSize: 11, color: failed ? '#ff5c5c' : 'var(--dim)', marginTop: 3 }}>
      {failed
        ? `${device.lastUpdateVersion} failed AND the rollback failed — no working agent`
        : `rolled back from ${device.lastUpdateVersion}`}
    </div>
  )
}
