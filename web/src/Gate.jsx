import { createContext, useContext, useEffect, useState } from 'react'
import { watchAuth, signInWithGoogle, signOutUser } from './firebase'
import { resolveAccess } from './access'
import { trefoilSvg, c } from './ui'

// The whole console lives inside this gate. Nothing renders — and, because the
// Firestore rules require a verified allow-listed identity for every control
// write, nothing WORKS — until a permitted Google account is signed in. The two
// layers are independent: this component is the UI, the rules are the enforcement,
// so hiding the UI is never the only thing standing between a stranger and a
// device.
const AccessContext = createContext(null)
export const useAccess = () => useContext(AccessContext)

export default function Gate({ children }) {
  const [state, setState] = useState({ phase: 'loading', user: null, access: null })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    return watchAuth(async (user) => {
      if (!user) { setState({ phase: 'signedout', user: null, access: null }); return }
      const access = await resolveAccess(user)
      setState({ phase: access.allowed ? 'in' : 'denied', user, access })
    })
  }, [])

  async function onSignIn() {
    setErr(null); setBusy(true)
    try { await signInWithGoogle() } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  if (state.phase === 'loading') return <Splash>Checking your access…</Splash>

  if (state.phase === 'signedout') {
    return (
      <Splash>
        <p style={{ color: 'var(--dim)', fontSize: 14, margin: '0 0 20px', maxWidth: 340, textAlign: 'center' }}>
          This console controls real devices. Sign in with an approved Google account to continue.
        </p>
        <button onClick={onSignIn} disabled={busy} style={{ ...c.primary, opacity: busy ? 0.5 : 1 }}>
          {busy ? 'Opening…' : 'Sign in with Google'}
        </button>
        {err && <p style={{ color: '#ff5c5c', fontSize: 13, marginTop: 14 }}>{err}</p>}
      </Splash>
    )
  }

  if (state.phase === 'denied') {
    return (
      <Splash>
        <p style={{ color: '#ffd7d7', fontSize: 14, margin: '0 0 6px', textAlign: 'center' }}>
          <strong>{state.user.email}</strong> is not on the access list.
        </p>
        <p style={{ color: 'var(--dim)', fontSize: 13, margin: '0 0 20px', textAlign: 'center' }}>
          Ask the administrator to add you, then sign in again.
        </p>
        <button onClick={() => signOutUser()} style={c.ghost}>Sign out</button>
      </Splash>
    )
  }

  return (
    <AccessContext.Provider value={{ user: state.user, access: state.access }}>
      {children}
    </AccessContext.Provider>
  )
}

function Splash({ children }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: 24 }}>
        <span style={{ display: 'inline-flex', marginBottom: 8 }} dangerouslySetInnerHTML={trefoilSvg(44)} />
        <h1 style={{ fontSize: 20, margin: '0 0 14px', fontWeight: 650 }}>projectBV</h1>
        {children}
      </div>
    </div>
  )
}
