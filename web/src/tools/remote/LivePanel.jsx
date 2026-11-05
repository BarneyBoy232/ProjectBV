import { useEffect, useRef, useState } from 'react'
import { CMD } from './protocol'
import { runCommand } from './data'
import { startSession } from './session'
import { loadLimits, saveLimits, clampPct, DEFAULT_LIMITS } from './limits'
import { c } from '../../ui'

// Bumped on every control change so we can confirm from the live screen which build
// is actually running — the old-code/new-code confusion has cost us repeatedly.
const BUILD = 'ctl-diag-1'

export function LivePanel({ device }) {
  const videoRef = useRef(null)
  const stageRef = useRef(null)
  const sessionRef = useRef(null)
  const lastMove = useRef(0)
  const lastEvt = useRef(null)   // last input we handed to the channel (debug)
  const [diag, setDiag] = useState(null)
  const [state, setState] = useState('idle')
  const [controlling, setControlling] = useState(false)
  const [perf, setPerf] = useState(null)
  const [full, setFull] = useState(false)
  const [showLimits, setShowLimits] = useState(false)
  const [sound, setSound] = useState(false)      // listening to the device's audio
  const [frozen, setFrozen] = useState(false)    // their keyboard + mouse blocked
  const canFreeze = (device.caps || []).includes('blockinput')
  // A ref does not re-render, so the Start/Stop button has to track the session in
  // state or it keeps saying "Stop" for a session that was refused.
  const [hasSession, setHasSession] = useState(false)

  function start() {
    if (sessionRef.current) return
    setState('connecting')
    sessionRef.current = startSession(device.id, {
      onStream: (stream) => { if (videoRef.current) videoRef.current.srcObject = stream },
      onState: (s) => setState(s),
    })
    setHasSession(true)
  }
  function stop() {
    setControl(false)
    if (frozen) toggleFreeze(false)
    setSound(false)
    sessionRef.current?.stop()
    sessionRef.current = null
    setHasSession(false)
    if (videoRef.current) videoRef.current.srcObject = null
    setState('idle')
    setPerf(null)
  }
  useEffect(() => () => { sessionRef.current?.stop(); sessionRef.current = null }, [])

  useEffect(() => {
    if (state !== 'ready') return
    let alive = true
    let h = null
    async function tick() {
      try { const r = await runCommand(device.id, CMD.PERF, {}, 8000); if (alive) setPerf(r.output) } catch {}
      if (alive) h = setTimeout(tick, 3000)
    }
    tick()
    return () => { alive = false; if (h) clearTimeout(h) }
  }, [state, device.id])

  // --- live diagnostics ---------------------------------------------------
  // Read straight off the peer connection so we can see what the stream and the
  // input channel are actually doing, instead of guessing.
  useEffect(() => {
    if (state !== 'ready' && state !== 'connected') { setDiag(null); return undefined }
    let alive = true
    let prevBytes = 0
    let prevTs = 0
    const h = setInterval(async () => {
      const peer = sessionRef.current?.peer
      if (!alive || !peer) return
      try {
        const stats = await peer.getStats()
        let vid = null
        let pair = null
        const cands = {}
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') vid = r
          if (r.type === 'candidate-pair' && r.nominated) pair = r
          if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r.candidateType
        })
        let kbps = 0
        if (vid) {
          const dt = (vid.timestamp - prevTs) / 1000
          if (prevTs && dt > 0) kbps = Math.round(((vid.bytesReceived - prevBytes) * 8) / 1000 / dt)
          prevBytes = vid.bytesReceived
          prevTs = vid.timestamp
        }
        const io = sessionRef.current?.io?.() || { sent: 0, dropped: 0 }
        const le = lastEvt.current
        setDiag({
          build: BUILD,
          chan: sessionRef.current?.channelState?.() || 'none',
          w: vid?.frameWidth || videoRef.current?.videoWidth || 0,
          h: vid?.frameHeight || videoRef.current?.videoHeight || 0,
          fps: Math.round(vid?.framesPerSecond || 0),
          kbps,
          lost: vid?.packetsLost ?? 0,
          jitter: vid ? Math.round((vid.jitter || 0) * 1000) : 0,
          rtt: pair ? Math.round((pair.currentRoundTripTime || 0) * 1000) : 0,
          path: pair ? `${cands[pair.localCandidateId] || '?'}/${cands[pair.remoteCandidateId] || '?'}` : '?',
          sent: io.sent,
          dropped: io.dropped,
          last: le ? le.t + (le.code ? ':' + le.code : '') : '—',
        })
      } catch { /* stats not ready */ }
    }, 1000)
    return () => { alive = false; clearInterval(h) }
  }, [state])

  // --- fullscreen ---------------------------------------------------------
  // The point of this view is to look at somebody's machine as if you were sitting
  // at it. In a panel on a dashboard page you are looking at a postage stamp of a
  // 1080p screen, which is fine for "is it on" and useless for actually using it.
  // Fullscreen puts the remote screen at 1:1 or close to it.
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stageRef.current?.requestFullscreen()
    } catch { /* the browser refused; the panel view still works */ }
  }

  // While controlling in fullscreen, Escape belongs to the remote machine, not to
  // the browser. Keyboard lock hands it over — the browser then needs Escape HELD
  // to leave, which is the standard way out and does not collide with a tap.
  useEffect(() => {
    if (!full || !controlling) return undefined
    navigator.keyboard?.lock?.(['Escape']).catch(() => {})
    return () => { try { navigator.keyboard?.unlock?.() } catch {} }
  }, [full, controlling])

  // Control is pointer-lock, GeForce-Now style: you grab the device by clicking its
  // screen (which captures and hides your own cursor), then see and drive ONLY the
  // device's cursor, with full range of motion, and Esc hands control back. There is
  // only ever one visible cursor — theirs — so the two can never drift apart.
  function setControl(on) {
    if (on) videoRef.current?.requestPointerLock?.()
    else document.exitPointerLock?.()
  }
  // controlling tracks the real pointer-lock state, not a checkbox, so releasing with
  // Esc (or the browser dropping the lock for any reason) always turns control off.
  useEffect(() => {
    const onChange = () => {
      const locked = document.pointerLockElement === videoRef.current
      setControlling(locked)
      // Drop focus off any dashboard control (e.g. the Take-control checkbox) the
      // moment control engages, so a keystroke like Space can't toggle it instead of
      // reaching the device.
      if (locked) document.activeElement?.blur?.()
    }
    document.addEventListener('pointerlockchange', onChange)
    return () => document.removeEventListener('pointerlockchange', onChange)
  }, [])

  // Listening plays the device's audio through the same <video>; muted otherwise.
  useEffect(() => { if (videoRef.current) videoRef.current.muted = !sound }, [sound, state])

  async function toggleFreeze(on) {
    setFrozen(on)
    try { await runCommand(device.id, CMD.BLOCK_INPUT, { on }, 8000) }
    catch { setFrozen(!on) }
  }

  const send = (evt) => { lastEvt.current = evt; sessionRef.current?.sendInput(evt) }
  // While the pointer is locked, movement arrives as deltas in the <video>'s own CSS
  // pixels. Convert them to captured-frame pixels (the agent then scales those to the
  // device's real screen — see input.js 'mr'). Because deltas accumulate, the whole
  // remote screen is reachable, not just the area of the panel.
  function frameScale() {
    const v = videoRef.current
    if (!v || !v.videoWidth || !v.videoHeight) return 1
    const rect = v.getBoundingClientRect()
    return Math.min(rect.width / v.videoWidth, rect.height / v.videoHeight) || 1
  }
  // The live stream is downscaled, so a raw delta under-travels the real screen and
  // the remote cursor crawls. SENS scales the movement back up to feel natural; it's
  // the one knob to turn if control feels too fast or too slow.
  const SENS = 2.2
  function onMove(e) {
    if (!controlling) return
    const now = performance.now()
    if (now - lastMove.current < 10) return
    lastMove.current = now
    const s = frameScale()
    send({ t: 'mr', dx: (e.movementX / s) * SENS, dy: (e.movementY / s) * SENS })
  }
  // First click on the screen grabs control (locks the pointer). Once controlling,
  // every click goes straight to the device — pointer lock keeps all of them on the
  // video, so a click can never fall through onto the dashboard behind it.
  function onDown(e) {
    if (!connected) return
    if (!controlling) { setControl(true); return }
    e.preventDefault()
    send({ t: 'd', b: e.button })
  }
  function onUp(e) { if (!controlling) return; e.preventDefault(); send({ t: 'u', b: e.button }) }
  function onWheel(e) { if (!controlling) return; e.preventDefault(); send({ t: 'w', dy: Math.sign(e.deltaY) * 3 }) }

  useEffect(() => {
    if (!controlling) return
    // Pointer-locked: every key belongs to the device. Prevent the browser's own
    // default for all of them — otherwise Space toggles the focused Take-control
    // checkbox, Tab moves focus, "/" opens quick-find, and none of them reach the
    // device. Escape is the single exception: it releases control.
    const down = (e) => {
      if (e.code === 'Escape') { document.exitPointerLock?.(); return }
      e.preventDefault(); send({ t: 'k', a: 'down', code: e.code })
    }
    const up = (e) => {
      if (e.code === 'Escape') return
      e.preventDefault(); send({ t: 'k', a: 'up', code: e.code })
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true) }
  }, [controlling])

  useEffect(() => { if (['failed', 'disconnected', 'closed'].includes(state)) setControl(false) }, [state])

  // A refused start leaves a half-open peer connection behind. Tearing it down
  // here — without clearing the state — puts the Start button back while the
  // reason for the refusal stays on screen.
  useEffect(() => {
    if (!state.startsWith('blocked:')) return
    sessionRef.current?.stop()
    sessionRef.current = null
    setHasSession(false)
    setControlling(false)
  }, [state])

  const connected = state === 'ready' || state === 'connected'
  const blocked = state.startsWith('blocked:')
  const statusText = {
    idle: 'not connected', connecting: 'connecting…', ready: 'live', connected: 'live',
    disconnected: 'disconnected — press Stop, then start again',
    failed: 'connection failed — press Stop, then start again', closed: 'disconnected',
  }[state] || (blocked ? state.replace('blocked:', '') : state.startsWith('error') ? state.replace('error:', 'error: ') : state)

  // A session that is already running is not cut off when the machine crosses a
  // ceiling — the operator may be in the middle of fixing the very thing causing
  // it, and pulling the screen out from under them would make that impossible.
  // It says so instead, and refuses the NEXT start.
  const overLimit = perf?.verdict && !perf.verdict.ok

  const stageStyle = full
    ? { position: 'relative', background: '#000', width: '100vw', height: '100vh' }
    : { position: 'relative', background: '#000', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)', minHeight: 240 }
  // No local cursor while controlling (you watch theirs); a pointer when connected to
  // signal "click to take control"; default otherwise.
  const videoCursor = controlling ? 'none' : connected ? 'pointer' : 'default'
  const videoStyle = full
    ? { display: 'block', width: '100vw', height: '100vh', objectFit: 'contain', cursor: videoCursor }
    : { display: 'block', width: '100%', maxHeight: '60vh', objectFit: 'contain', cursor: videoCursor }

  return (
    <section style={c.panel}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={c.h2}>Live screen</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 12, color: connected ? 'var(--ok)' : (blocked || state.startsWith('error')) ? 'var(--bad)' : 'var(--dim)' }}>
            <span style={c.dot(connected)} />{statusText}
          </span>
          {connected && <button style={{ ...c.ghost, opacity: sound ? 1 : 0.65 }} onClick={() => setSound((v) => !v)}>{sound ? 'Sound on' : 'Sound off'}</button>}
          {connected && canFreeze && <button style={{ ...c.ghost, color: frozen ? 'var(--bad)' : undefined }} onClick={() => toggleFreeze(!frozen)}>{frozen ? 'Unfreeze input' : 'Freeze their input'}</button>}
          {connected && <button style={c.ghost} onClick={toggleFullscreen}>Fullscreen</button>}
          {hasSession ? (
            <button style={c.ghost} onClick={stop}>Stop</button>
          ) : (
            <button style={c.primary} onClick={start} disabled={!device.agentOnline}>Start live view</button>
          )}
        </div>
      </div>

      <div ref={stageRef} style={stageStyle} onDoubleClick={connected ? toggleFullscreen : undefined}>
        <video ref={videoRef} autoPlay playsInline muted onMouseMove={onMove} onMouseDown={onDown} onMouseUp={onUp} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()}
          style={videoStyle} />
        {!connected && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--dim)', fontSize: 13, textAlign: 'center', padding: 20 }}>
            {state === 'connecting' ? 'Connecting to the device…'
              : blocked ? statusText
              : 'Start the live view to see this device’s screen.'}
          </div>
        )}
        {connected && !controlling && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '10px 12px', background: 'linear-gradient(transparent, rgba(0,0,0,0.55))', color: '#fff', fontSize: 12, textAlign: 'center', pointerEvents: 'none' }}>
            Click the screen to take control · Esc gives it back
          </div>
        )}
        {controlling && (
          <div style={{ position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 12, padding: '4px 10px', borderRadius: 8, pointerEvents: 'none' }}>
            Controlling — Esc to release
          </div>
        )}
        {full && (
          <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 8, alignItems: 'center', background: 'rgba(0,0,0,0.6)', borderRadius: 8, padding: '6px 10px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#fff' }}>
              <input type="checkbox" checked={controlling} onChange={(e) => setControl(e.target.checked)} />
              Control
            </label>
            <button style={{ ...c.ghost, padding: '4px 9px', fontSize: 12 }} onClick={() => setSound((v) => !v)}>{sound ? 'Sound on' : 'Sound off'}</button>
            {canFreeze && <button style={{ ...c.ghost, padding: '4px 9px', fontSize: 12, color: frozen ? 'var(--bad)' : undefined }} onClick={() => toggleFreeze(!frozen)}>{frozen ? 'Unfreeze' : 'Freeze'}</button>}
            <button style={{ ...c.ghost, padding: '4px 9px', fontSize: 12 }} onClick={toggleFullscreen}>Exit</button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: connected ? 'pointer' : 'not-allowed', opacity: connected ? 1 : 0.5 }}>
          <input type="checkbox" disabled={!connected} checked={controlling} onChange={(e) => setControl(e.target.checked)} />
          Take control — their screen, your mouse and keyboard (like GeForce Now). Esc hands control back.
        </label>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {perf && (
            <span style={{ fontSize: 12, color: overLimit ? 'var(--bad)' : 'var(--dim)' }}>
              this app: CPU {perf.agentCpuPct}% · RAM {perf.agentMemMB} MB ({perf.agentMemPct}%) · device RAM {perf.memPct}%
            </span>
          )}
          <button style={{ ...c.ghost, padding: '5px 10px', fontSize: 12 }} onClick={() => setShowLimits((v) => !v)}>Limits</button>
        </div>
      </div>

      {overLimit && (
        <div style={{ fontSize: 12, color: 'var(--bad)', marginTop: 8 }}>
          Over the limit — {perf.verdict.reason}. The session keeps running; the next one will be refused.
        </div>
      )}

      {diag && (
        <div style={{ fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11, color: 'var(--dim)', marginTop: 10, lineHeight: 1.6, wordBreak: 'break-all', borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div>build <strong style={{ color: 'var(--text)' }}>{diag.build}</strong> · channel <strong style={{ color: diag.chan === 'open' ? 'var(--ok)' : 'var(--bad)' }}>{diag.chan}</strong> · input sent {diag.sent} · dropped <strong style={{ color: diag.dropped ? 'var(--bad)' : 'var(--dim)' }}>{diag.dropped}</strong> · last {diag.last}</div>
          <div>{diag.w}×{diag.h} @ {diag.fps}fps · {diag.kbps} kbps · lost {diag.lost} · jitter {diag.jitter}ms · rtt {diag.rtt}ms · path {diag.path}</div>
        </div>
      )}

      {showLimits && <LimitsEditor onClose={() => setShowLimits(false)} />}
    </section>
  )
}

function LimitsEditor({ onClose }) {
  const [values, setValues] = useState(null)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState(null)
  const [failed, setFailed] = useState(null)

  useEffect(() => { loadLimits().then(setValues).catch((e) => setFailed(e.message)) }, [])

  if (failed) {
    return (
      <div style={{ ...c.panel, marginTop: 14, marginBottom: 0, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--bad)' }}>Could not read the limits: {failed}</span>
        <button style={c.ghost} onClick={onClose}>Close</button>
      </div>
    )
  }
  if (!values) return <div style={{ ...c.panel, marginTop: 14, marginBottom: 0 }}><span style={{ fontSize: 13, color: 'var(--dim)' }}>Reading…</span></div>

  const field = (key, label) => (
    <label style={{ display: 'grid', gap: 5 }}>
      <span style={c.label}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="number" min={10} max={100} value={values[key]}
          onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
          onBlur={() => setValues((v) => ({ ...v, [key]: clampPct(v[key], DEFAULT_LIMITS[key]) }))}
          style={{ ...c.input, width: 90 }} />
        <span style={{ fontSize: 13, color: 'var(--dim)' }}>%</span>
      </span>
    </label>
  )

  async function save() {
    setSaving(true)
    try {
      setValues(await saveLimits(values))
      setNote({ text: 'Saved — every device picks this up straight away.' })
    } catch (e) {
      setNote({ bad: true, text: e.message })
    }
    setSaving(false)
  }

  return (
    <div style={{ ...c.panel, marginTop: 14, marginBottom: 0 }}>
      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        {field('appRamPct', 'Refuse to stream when this app is at or above')}
        {field('machineRamPct', 'Refuse to stream when the device is at or above')}
        <button style={c.ghost} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
        <button style={c.ghost} onClick={onClose}>Close</button>
      </div>
      {note && <div style={{ fontSize: 12, color: note.bad ? 'var(--bad)' : 'var(--dim)', marginTop: 10 }}>{note.text}</div>}
    </div>
  )
}
