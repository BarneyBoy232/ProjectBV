import { useEffect, useMemo, useState } from 'react'
import { loadDevices, setEnabled } from './devices'
import { watchDevice, act } from './data'
import ProcessesTab, { groupOf } from './ProcessesTab'
import PerformanceTab from './PerformanceTab'
import { ServicesTab, StartupTab, UsersTab } from './ListTabs'
import { usePersistentSelection } from '../../persist'
import { c, ago } from '../../ui'

const TABS = [
  { id: 'processes', label: 'Processes' },
  { id: 'performance', label: 'Performance' },
  { id: 'details', label: 'Details' },
  { id: 'services', label: 'Services' },
  { id: 'startup', label: 'Startup' },
  { id: 'users', label: 'Users' },
]

// A minute of history at the 2s cadence — enough to see a spike that has already
// passed, which is the whole reason a graph beats a number.
const HISTORY = 60
const EMPTY_HISTORY = { cpu: [], mem: [], gpu: [], disk: {}, net: {} }

function push(arr, v) {
  const next = (arr || []).length >= HISTORY ? arr.slice(1) : (arr || []).slice()
  next.push(v)
  return next
}

// Disks and adapters are keyed by NAME, not by position. Plugging in a USB drive or
// bringing an adapter up reorders the array mid-session, and index-keyed history
// would quietly hand one device's past to another.
function pushByName(map, items, value) {
  const next = {}
  for (const it of items) next[it.name] = push(map[it.name], value(it))
  return next
}

export default function MonitorPage() {
  const [devices, setDevices] = useState([])
  const [selected, setSelected] = usePersistentSelection('device')
  const [err, setErr] = useState(null)

  async function refresh() {
    try { setDevices(await loadDevices()); setErr(null) }
    catch (e) { setErr('Cannot reach Firebase: ' + e.message) }
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t) }, [])

  const device = devices.find((d) => d.id === selected) || null
  const ready = devices.filter((d) => d.agentOnline && d.enabled).length

  return (
    <div className="tool-grid">
      <aside>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={c.h2}>Fleet devices</h2>
          {devices.length > 0 && <span style={{ fontSize: 12, color: 'var(--dim)' }}>{ready} ready / {devices.length}</span>}
        </div>
        {err && <div style={{ color: 'var(--bad)', fontSize: 13, marginBottom: 10 }}>{err}</div>}
        {devices.length === 0 ? <div style={c.empty}>No devices yet.</div> : devices.map((d) => {
          const on = selected === d.id
          const label = !d.hasAgent ? 'needs agent update'
            : !d.agentOnline ? `offline · ${ago(d.agentLastSeen)}`
            : d.enabled ? (d.streaming ? 'streaming' : 'ready') : 'switched off'
          return (
            <button key={d.id} onClick={() => setSelected(d.id)}
              style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8, cursor: 'pointer', background: on ? 'var(--panel2)' : 'transparent', border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`, color: 'var(--text)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{d.name}</div>
              <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 3 }}><span style={c.dot(d.agentOnline && d.enabled)} />{label}</div>
            </button>
          )
        })}
      </aside>
      <main style={{ minWidth: 0 }}>
        {device ? <DeviceMonitor key={device.id} device={device} onChanged={refresh} /> : <div style={{ ...c.empty, marginTop: 40 }}>Pick a device to watch.</div>}
      </main>
    </div>
  )
}

function DeviceMonitor({ device, onChanged }) {
  const [tab, setTab] = useState('processes')
  const [sample, setSample] = useState(null)
  const [meta, setMeta] = useState(null)
  const [history, setHistory] = useState(EMPTY_HISTORY)
  const [note, setNote] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lastFrame, setLastFrame] = useState(0)
  const [ask, setAsk] = useState(null)
  const [, setTick] = useState(0)

  // Nothing re-renders this view when frames STOP arriving, which is exactly the
  // moment "live" stops being true. A slow tick keeps that honest.
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 5000); return () => clearInterval(t) }, [])

  const canStream = device.agentOnline && device.enabled

  // The lease is held only while this device's view is open. Leaving the page (or
  // closing the tab) lets it expire, and the device stops sampling on its own.
  useEffect(() => {
    if (!canStream) return undefined
    const w = watchDevice(device.id, {
      intervalMs: 2000,
      onSample: (data) => {
        setSample(data)
        setLastFrame(Date.now())
        setHistory((h) => ({
          cpu: push(h.cpu, data.cpu?.pct ?? 0),
          mem: push(h.mem, data.mem?.totalB ? ((data.mem.totalB - data.mem.availableB) / data.mem.totalB) * 100 : 0),
          gpu: push(h.gpu, data.gpu?.totalPct ?? 0),
          disk: pushByName(h.disk, data.disks || [], (d) => d.activePct),
          net: pushByName(h.net, data.nets || [], (n) => (n.sendBps || 0) + (n.recvBps || 0)),
        }))
      },
      onMeta: (data) => setMeta(data),
      onError: (m) => setNote({ text: m, bad: true }),
    })
    return () => w.stop()
  }, [device.id, canStream])

  // One row per process: the fast counters keyed by pid, joined to the slow facts.
  const rows = useMemo(() => {
    const byPid = new Map((meta?.procs || []).map((m) => [m.pid, m]))
    const gpuByPid = sample?.gpu?.perPid || {}
    return (sample?.procs || []).map((p) => {
      const m = byPid.get(p.pid) || {}
      // Before the first meta frame all we have is the performance counter's
      // instance name, where a second copy of chrome is "chrome#12". Showing that
      // to the operator would be showing them our plumbing.
      const fallback = `${String(p.key).replace(/#\d+$/, '')}.exe`
      const row = {
        ...m,
        pid: p.pid,
        name: m.name || fallback,
        cpu: p.cpu || 0,
        memB: p.memB || 0,
        ioBps: p.ioBps || 0,
        threads: p.threads || 0,
        handles: p.handles || 0,
        upSec: p.upSec || 0,
        gpuPct: Number(gpuByPid[String(p.pid)] || 0),
        label: m.title || m.desc || m.name || fallback,
      }
      row.group = groupOf(row)
      return row
    })
  }, [sample, meta])

  async function perform(args, after) {
    setBusy(true)
    setNote(null)
    try {
      await act(device.id, args)
      setNote({ text: `Done: ${args.action.replace(/_/g, ' ')}.` })
      if (after) await after()
    } catch (e) {
      setNote({
        bad: true,
        text: e.refused
          ? `Refused by the device: ${e.message}`
          : e.needsAdmin
            ? `Windows refused: ${e.message} — this agent runs as the signed-in user, so anything needing administrator cannot be done from here yet.`
            : e.message,
      })
    }
    setBusy(false)
  }

  // Anything that destroys work or takes something away asks first. The device
  // refuses the handful of actions that would strand it regardless of this, but a
  // wrong row is far more likely than a malicious one, and this is what catches it.
  function onAct(args, after, confirm) {
    if (!confirm) return perform(args, after)
    setAsk({ args, after, text: confirm })
    return undefined
  }

  const toggle = async (on) => { await setEnabled(device.id, on); onChanged?.() }

  if (!device.hasAgent) {
    return <div style={c.panel}>No Task Manager agent on {device.name}. It ships in the BV Remote installer — push the current build from the Remote tool.</div>
  }
  if (!device.agentOnline) return <div style={c.panel}>{device.name} last checked in {ago(device.agentLastSeen)}.</div>
  if (!device.enabled) {
    return (
      <div style={{ ...c.panel, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span>Task Manager is switched off for {device.name}.</span>
        <button style={c.primary} onClick={() => toggle(true)}>Turn on</button>
      </div>
    )
  }

  const stale = lastFrame && Date.now() - lastFrame > 12000
  const live = sample && !stale

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
        <h2 style={{ ...c.h2, fontSize: 16, margin: 0 }}>{device.name}</h2>
        <span style={{ fontSize: 12, color: live ? 'var(--ok)' : 'var(--dim)' }}>
          <span style={c.dot(!!live)} />{live ? 'live' : sample ? 'frames have stopped' : 'connecting…'}
        </span>
        {meta?.machine && <span style={{ fontSize: 12, color: 'var(--dim)' }}>{meta.machine.osName} · {meta.machine.cores} cores</span>}
        <button style={{ ...c.ghost, padding: '5px 10px', fontSize: 12 }} onClick={() => toggle(false)}>Switch off</button>
        <div style={{ flex: 1 }} />
        <nav style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ background: tab === t.id ? 'var(--panel2)' : 'transparent', border: `1px solid ${tab === t.id ? 'var(--line)' : 'transparent'}`, color: tab === t.id ? 'var(--text)' : 'var(--dim)', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'processes' && <ProcessesTab rows={rows} machine={meta?.machine} onAct={onAct} busy={busy} note={note} />}
      {tab === 'details' && <ProcessesTab rows={rows} machine={meta?.machine} flat onAct={onAct} busy={busy} note={note} />}
      {tab === 'performance' && <PerformanceTab sample={sample} machine={meta?.machine} history={history} />}
      {tab === 'services' && <ServicesTab deviceId={device.id} onAct={onAct} busy={busy} />}
      {tab === 'startup' && <StartupTab deviceId={device.id} onAct={onAct} busy={busy} />}
      {tab === 'users' && <UsersTab deviceId={device.id} rows={rows} onAct={onAct} busy={busy} />}

      {note && tab !== 'processes' && tab !== 'details' && (
        <div style={{ fontSize: 12, color: note.bad ? 'var(--bad)' : 'var(--dim)', marginTop: 12 }}>{note.text}</div>
      )}

      {ask && (
        <Ask text={ask.text} busy={busy}
          onCancel={() => setAsk(null)}
          onGo={() => { const a = ask; setAsk(null); perform(a.args, a.after) }} />
      )}
    </>
  )
}

function Ask({ text, busy, onCancel, onGo }) {
  return (
    <div onClick={onCancel} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'grid', placeItems: 'center', zIndex: 50, padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...c.panel, marginBottom: 0, maxWidth: 460, boxShadow: '0 18px 50px rgba(0,0,0,0.5)' }}>
        <div style={{ fontSize: 14, marginBottom: 18 }}>{text}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button style={c.ghost} onClick={onCancel}>Cancel</button>
          <button style={{ ...c.ghost, borderColor: 'var(--bad)', color: 'var(--bad)' }} disabled={busy} onClick={onGo}>Do it</button>
        </div>
      </div>
    </div>
  )
}
