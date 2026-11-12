import { useEffect, useState } from 'react'
import DeployPage from './DeployPage'
import AccessPage from './AccessPage'
import { listDevices, listManifest, AGENT_NAME } from './api'
import { TOOLS } from './tools'
import { trefoilSvg, c } from './ui'
import Gate, { useAccess } from './Gate'
import { signOutUser } from './firebase'

// The console sits inside the Gate: it only ever renders for a verified,
// allow-listed operator, and the Firestore rules enforce that same allow-list on
// every control write — so the login is real, not cosmetic.
export default function App() {
  return (
    <Gate>
      <Console />
    </Gate>
  )
}

function Console() {
  const { user, access } = useAccess()
  const isAdmin = access?.role === 'admin'
  const [view, setView] = useState({ kind: 'deploy' })
  const isTools = view.kind === 'tools' || view.kind === 'tool'

  const navItem = (active, label, onClick) => (
    <button onClick={onClick} style={{ background: 'none', border: 0, borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`, color: active ? 'var(--text)' : 'var(--dim)', padding: '10px 4px', marginRight: 22, cursor: 'pointer', fontSize: 14, fontWeight: active ? 600 : 400 }}>
      {label}
    </button>
  )

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 24px', borderBottom: '1px solid var(--line)', background: 'var(--panel)' }}>
        <span style={{ display: 'inline-flex' }} dangerouslySetInnerHTML={trefoilSvg(28)} />
        <h1 style={{ fontSize: 17, margin: 0, fontWeight: 650 }}>projectBV</h1>
        <nav style={{ marginLeft: 22, display: 'flex' }}>
          {navItem(view.kind === 'deploy', 'Deploy', () => setView({ kind: 'deploy' }))}
          {navItem(isTools, 'Tools', () => setView({ kind: 'tools' }))}
          {isAdmin && navItem(view.kind === 'access', 'Access', () => setView({ kind: 'access' }))}
        </nav>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 12, color: 'var(--dim)' }}>{user?.email}</span>
          <button onClick={() => signOutUser()} style={{ ...c.ghost, fontSize: 12, padding: '5px 10px' }}>Sign out</button>
        </div>
      </header>
      <StrandedDevices />
      <main style={{ maxWidth: isTools ? 1120 : 920, margin: '0 auto', padding: 24 }}>
        {view.kind === 'deploy' && <DeployPage />}
        {view.kind === 'tools' && <ToolsLanding onOpen={(id) => setView({ kind: 'tool', id })} />}
        {view.kind === 'tool' && <ToolView id={view.id} onBack={() => setView({ kind: 'tools' })} />}
        {view.kind === 'access' && (isAdmin ? <AccessPage /> : <div style={c.empty}>Admins only.</div>)}
      </main>
    </div>
  )
}

// A device with no working agent can never be reached or fixed from here again —
// someone has to go to it. It is the only outcome that breaks what this product is
// for, so it is called out above everything, on every screen.
//
// It is found two ways, because the obvious way cannot work on its own: a device
// that reports "the rollback failed" is telling you through the very agent that
// just died, so the worst case is the one that can never report itself. The second
// way is what an outsider can actually observe — an agent update was pushed to
// this device, and it has not been heard from since.
const QUIET_AFTER_UPDATE_MS = 2 * 60 * 60 * 1000

function StrandedDevices() {
  const [lost, setLost] = useState([])
  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const [devices, manifest] = await Promise.all([listDevices(), listManifest()])
        if (!alive) return
        const agentEntries = manifest.filter((m) => m.name === AGENT_NAME && m.publishedAt)
        const pushedTo = (device) => agentEntries
          .filter((m) => !m.targets || m.targets.length === 0 || m.targets.includes(device.id))
          .reduce((newest, m) => Math.max(newest, m.publishedAt), 0)

        const now = Date.now()
        setLost(devices.filter((d) => {
          if (d.lastUpdateResult === 'rollback-failed') return true
          const pushed = pushedTo(d)
          if (!pushed || now - pushed < QUIET_AFTER_UPDATE_MS) return false
          // Both halves are measured against this browser's clock, never against
          // each other: a device timestamps its own check-ins, so comparing its
          // clock to ours would flag a machine with a slow clock for ever.
          return !d.lastSeen || now - d.lastSeen > QUIET_AFTER_UPDATE_MS
        }))
      } catch {
        /* the banner is not the place to report a Firebase problem */
      }
    }
    check()
    const t = setInterval(check, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  if (lost.length === 0) return null
  return (
    <div style={{ background: '#3a1414', borderBottom: '1px solid #ff5c5c', color: '#ffd7d7', padding: '12px 24px', fontSize: 13 }}>
      <strong>{lost.length === 1 ? '1 device has not checked in since an agent update' : `${lost.length} devices have not checked in since an agent update`}</strong>
      {' — '}{lost.map((d) => d.name || d.id).join(', ')}
      {'. '}Switched off would look the same. If they stay silent, they may have no working agent — which cannot be fixed from here, only by running the installer on them.
    </div>
  )
}

function ToolsLanding({ onOpen }) {
  return (
    <>
      <h2 style={{ ...c.h2, fontSize: 18, marginBottom: 4 }}>Tools</h2>
      <p style={{ ...c.sub, marginBottom: 20 }}>Add-on tools that plug into your projectBV fleet. More can be added over time.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 16 }}>
        {TOOLS.map((t) => (
          <button key={t.id} onClick={() => onOpen(t.id)} style={{ textAlign: 'left', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12, padding: 18, cursor: 'pointer', color: 'var(--text)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              <span style={{ display: 'inline-flex' }} dangerouslySetInnerHTML={t.icon(22)} />
              <span style={{ fontWeight: 650, fontSize: 15 }}>{t.name}</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--dim)' }}>{t.tagline}</div>
          </button>
        ))}
        <div style={{ border: '1px dashed var(--line)', borderRadius: 12, padding: 18, color: 'var(--dim)', fontSize: 13, display: 'grid', placeItems: 'center', textAlign: 'center' }}>More tools coming</div>
      </div>
    </>
  )
}

function ToolView({ id, onBack }) {
  const tool = TOOLS.find((t) => t.id === id)
  if (!tool) return <div style={c.empty}>Unknown tool.</div>
  const Comp = tool.component
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <button onClick={onBack} style={{ ...c.ghost, fontSize: 13 }}>← Tools</button>
        <span style={{ display: 'inline-flex' }} dangerouslySetInnerHTML={tool.icon(20)} />
        <h2 style={{ ...c.h2, fontSize: 17, margin: 0 }}>{tool.name}</h2>
      </div>
      <Comp />
    </>
  )
}
