import { useEffect, useRef, useState } from 'react'
import { CMD } from './protocol'
import { runCommand } from './data'
import { startSession } from './session'
import { c } from '../../ui'

// The watch view: one device's screen, its speaker output and microphone, and a
// live feed of the real keyboard/mouse the person at the machine is using. Nothing
// is stored — this shows only what is happening right now, and only while open.
export function LivePanel({ device }) {
  const videoRef = useRef(null) // screen + speaker-output audio (one stream)
  const micRef = useRef(null) // microphone (audio-only stream)
  const stageRef = useRef(null)
  const sessionRef = useRef(null)

  const [state, setState] = useState('idle')
  const [full, setFull] = useState(false)
  const [hearOutput, setHearOutput] = useState(true)
  const [hearMic, setHearMic] = useState(true)
  const [perf, setPerf] = useState(null)
  const [screenStream, setScreenStream] = useState(null)
  const [micStream, setMicStream] = useState(null)

  // The live input feed. Kept in a ref (mutated fast) and mirrored to state on a
  // gentle interval, so a burst of keystrokes doesn't re-render on every event.
  const feedRef = useRef([])
  const [feed, setFeed] = useState([])
  const [mouse, setMouse] = useState(null)

  function onCapture(evt) {
    if (evt.t === 'm') { setMouse({ x: evt.x, y: evt.y }); return } // cursor: shown live, not logged
    const line =
      evt.t === 'k' ? { kind: 'key', text: evt.name, down: evt.a === 'down' }
      : evt.t === 'd' ? { kind: 'click', text: `${evt.b} down` }
      : evt.t === 'u' ? { kind: 'click', text: `${evt.b} up` }
      : evt.t === 'w' ? { kind: 'scroll', text: evt.dy > 0 ? 'scroll down' : 'scroll up' }
      : null
    if (!line) return
    const arr = feedRef.current
    arr.push({ ...line, id: `${Date.now()}-${arr.length}` })
    if (arr.length > 240) arr.splice(0, arr.length - 240)
  }

  useEffect(() => {
    if (state !== 'ready') return
    const t = setInterval(() => setFeed(feedRef.current.slice(-120)), 250)
    return () => clearInterval(t)
  }, [state])

  function onStream(stream) {
    // The stream with a video track is the screen (it also carries speaker output);
    // an audio-only stream is the microphone.
    if (stream.getVideoTracks().length) {
      setScreenStream(stream)
      if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play?.().catch(() => {}) }
    } else {
      setMicStream(stream)
      if (micRef.current) { micRef.current.srcObject = stream; micRef.current.play?.().catch(() => {}) }
    }
  }

  function start() {
    if (sessionRef.current) return
    feedRef.current = []
    setFeed([]); setMouse(null); setScreenStream(null); setMicStream(null)
    setState('connecting')
    sessionRef.current = startSession(device.id, { onStream, onCapture, onState: setState })
  }
  function stop() {
    sessionRef.current?.stop()
    sessionRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    if (micRef.current) micRef.current.srcObject = null
    setState('idle'); setPerf(null); setScreenStream(null); setMicStream(null)
  }
  useEffect(() => () => { sessionRef.current?.stop(); sessionRef.current = null }, [])

  // Mute/unmute follows the toggles.
  useEffect(() => { if (videoRef.current) videoRef.current.muted = !hearOutput }, [hearOutput, screenStream])
  useEffect(() => { if (micRef.current) micRef.current.muted = !hearMic }, [hearMic, micStream])

  // Perf readout while live — same shape the Remote tool shows, so the operator can
  // see how close the device is to the streaming limit it shares with Remote.
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

  // Fullscreen — the point of watching is to look as if you were at the machine.
  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await stageRef.current?.requestFullscreen()
    } catch {}
  }

  const connected = state === 'ready' || state === 'connected'
  const blocked = state.startsWith('blocked:')
  const statusText = {
    idle: 'not connected', connecting: 'connecting…', ready: 'live', connected: 'live',
    disconnected: 'disconnected — press Stop, then start again',
    failed: 'connection failed — press Stop, then start again', closed: 'disconnected',
  }[state] || (blocked ? state.replace('blocked:', '') : state.startsWith('error') ? state.replace('error:', 'error: ') : state)

  // A refused start leaves a half-open peer connection behind — tear it down but
  // leave the reason on screen.
  useEffect(() => {
    if (!state.startsWith('blocked:')) return
    sessionRef.current?.stop(); sessionRef.current = null
  }, [state])

  const overLimit = perf?.verdict && !perf.verdict.ok

  const stageStyle = full
    ? { position: 'relative', background: '#000', width: '100vw', height: '100vh' }
    : { position: 'relative', background: '#000', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)', minHeight: 240 }
  const videoStyle = full
    ? { display: 'block', width: '100vw', height: '100vh', objectFit: 'contain' }
    : { display: 'block', width: '100%', maxHeight: '60vh', objectFit: 'contain' }

  return (
    <section style={c.panel}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={c.h2}>Live watch</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={{ fontSize: 12, color: connected ? 'var(--ok)' : (blocked || state.startsWith('error')) ? 'var(--bad)' : 'var(--dim)' }}>
            <span style={c.dot(connected)} />{statusText}
          </span>
          {connected && <button style={c.ghost} onClick={toggleFullscreen}>Fullscreen</button>}
          {sessionRef.current
            ? <button style={c.ghost} onClick={stop}>Stop</button>
            : <button style={c.primary} onClick={start} disabled={!device.agentOnline}>Start watching</button>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 260px', gap: 16, alignItems: 'start' }}>
        <div>
          <div ref={stageRef} style={stageStyle} onDoubleClick={connected ? toggleFullscreen : undefined}>
            <video ref={videoRef} autoPlay playsInline style={videoStyle} />
            {!connected && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--dim)', fontSize: 13, textAlign: 'center', padding: 20 }}>
                {state === 'connecting' ? 'Connecting to the device…' : blocked ? statusText : 'Start watching to see and hear this device.'}
              </div>
            )}
          </div>

          {/* Microphone audio is separate from the video's speaker-output audio. */}
          <audio ref={micRef} autoPlay style={{ display: 'none' }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, opacity: connected ? 1 : 0.5 }}>
              <input type="checkbox" disabled={!connected} checked={hearOutput} onChange={(e) => setHearOutput(e.target.checked)} />
              Speaker output
              <Meter stream={hearOutput ? screenStream : null} />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, opacity: connected ? 1 : 0.5 }}>
              <input type="checkbox" disabled={!connected} checked={hearMic} onChange={(e) => setHearMic(e.target.checked)} />
              Microphone
              <Meter stream={hearMic ? micStream : null} />
            </label>
            <div style={{ marginLeft: 'auto', fontSize: 12, color: overLimit ? 'var(--bad)' : 'var(--dim)' }}>
              {perf && <>this app: CPU {perf.agentCpuPct}% · RAM {perf.agentMemMB} MB ({perf.agentMemPct}%) · device RAM {perf.memPct}%</>}
            </div>
          </div>
          {overLimit && (
            <div style={{ fontSize: 12, color: 'var(--bad)', marginTop: 8 }}>
              Over the limit — {perf.verdict.reason}. The session keeps running; the next one will be refused.
            </div>
          )}
        </div>

        <InputFeed feed={feed} mouse={mouse} live={connected} />
      </div>
    </section>
  )
}

// A small live level meter for a MediaStream's audio, so the operator can see sound
// is coming through even with the tab muted or the room quiet.
function Meter({ stream }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!stream || !stream.getAudioTracks().length) { setLevel(0); return }
    let ctx, raf, analyser
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)()
      const srcNode = ctx.createMediaStreamSource(stream)
      analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      srcNode.connect(analyser)
      const buf = new Uint8Array(analyser.frequencyBinCount)
      const loop = () => {
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v }
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3))
        raf = requestAnimationFrame(loop)
      }
      loop()
    } catch { /* metering is a nicety; if the browser refuses, skip it */ }
    return () => { if (raf) cancelAnimationFrame(raf); if (ctx) ctx.close().catch(() => {}) }
  }, [stream])

  return (
    <span style={{ display: 'inline-block', width: 46, height: 6, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}>
      <span style={{ display: 'block', height: '100%', width: `${Math.round(level * 100)}%`, background: 'var(--ok)', transition: 'width 80ms linear' }} />
    </span>
  )
}

// The live keyboard + mouse feed. Keys, clicks and scrolls scroll past; the pointer
// position is shown live at the top rather than flooding the log.
function InputFeed({ feed, mouse, live }) {
  const boxRef = useRef(null)
  useEffect(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight }, [feed])

  const color = (k) => (k === 'key' ? 'var(--text)' : k === 'click' ? '#ffd200' : 'var(--dim)')
  return (
    <aside style={{ ...c.panel, marginBottom: 0, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ ...c.h2, fontSize: 13 }}>Keyboard &amp; mouse</h3>
        <span style={{ fontSize: 11, color: 'var(--dim)' }}>{mouse ? `x ${mouse.x}, y ${mouse.y}` : live ? '—' : ''}</span>
      </div>
      <div ref={boxRef} style={{ height: 300, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12, lineHeight: 1.55 }}>
        {feed.length === 0
          ? <div style={{ color: 'var(--dim)' }}>{live ? 'Waiting for input…' : 'Not watching.'}</div>
          : feed.map((e) => (
              <div key={e.id} style={{ color: color(e.kind), opacity: e.kind === 'key' && !e.down ? 0.45 : 1 }}>
                {e.kind === 'key' ? `${e.down ? '▼' : '▲'} ${e.text}` : e.text}
              </div>
            ))}
      </div>
    </aside>
  )
}
