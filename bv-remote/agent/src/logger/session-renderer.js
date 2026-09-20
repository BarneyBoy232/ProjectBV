// Logger session renderer (device side). Captures the screen, the system/speaker
// output (loopback), and the microphone; creates the WebRTC offer; and forwards
// the captured keyboard/mouse events over a data channel. Everything is relayed
// through the preload bridge (window.bvSession). No imports — browser globals only.
//
// This is the observe-only twin of ../session-renderer.js: it adds audio and a
// one-way capture channel, and it never creates an input-injection channel, so a
// Logger session can watch and listen but can never drive the machine.
let pc = null
let capChannel = null
let nonce = null
let videoSender = null
let caps = { mic: true, systemAudio: true, capture: true }

const MAX_BITRATE = 12_000_000 // 12 Mbps — plenty for a sharp, smooth 1080p desktop

// applyFps changes the streaming framerate on the fly without renegotiating.
function applyFps(fps) {
  if (!videoSender) return
  const params = videoSender.getParameters()
  if (!params.encodings || !params.encodings.length) params.encodings = [{}]
  params.encodings[0].maxFramerate = fps
  params.encodings[0].maxBitrate = MAX_BITRATE
  videoSender.setParameters(params).catch(() => {})
}

window.bvSession.onStart(async ({ nonce: n, caps: c }) => {
  nonce = n
  if (c) caps = c
  try {
    await begin()
  } catch (e) {
    console.error('[bv-logger-session] begin failed:', e && e.message)
  }
})

async function begin() {
  const src = await window.bvSession.getSource()
  if (!src) throw new Error('no screen source available')

  // The screen. When systemAudio is on, asking for desktop audio in the SAME call
  // gives Windows loopback — exactly what the speakers/headphones are playing —
  // as an audio track inside this one stream. So this stream is "screen + what you
  // can hear", and the dashboard tells it apart from the mic by it having video.
  const screenStream = await navigator.mediaDevices.getUserMedia({
    audio: caps.systemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: src.id,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 60,
      },
    },
  })

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })

  screenStream.getTracks().forEach((t) => {
    if (t.kind === 'video') t.contentHint = 'motion'
    pc.addTrack(t, screenStream)
  })
  videoSender = pc.getSenders().find((s) => s.track && s.track.kind === 'video') || null
  applyFps(60)

  // The microphone — a SEPARATE stream, so it arrives at the dashboard as an
  // audio-only stream (no video track) and can be told apart from the speaker
  // output and muted/unmuted on its own.
  if (caps.mic) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      micStream.getTracks().forEach((t) => pc.addTrack(t, micStream))
    } catch (e) {
      console.error('[bv-logger-session] mic unavailable:', e && e.message)
    }
  }

  // One-way capture channel: the device SENDS the real keyboard/mouse events the
  // person is producing; the dashboard receives and shows them. The main process
  // owns the OS hook and pushes each event here.
  if (caps.capture) {
    capChannel = pc.createDataChannel('capture')
    window.bvSession.onCaptureEvent((evt) => {
      if (capChannel && capChannel.readyState === 'open') {
        try { capChannel.send(JSON.stringify(evt)) } catch {}
      }
    })
  }

  window.bvSession.onSetFps && window.bvSession.onSetFps((fps) => applyFps(fps))

  pc.onicecandidate = (e) => {
    if (e.candidate) window.bvSession.sendCandidate(nonce, e.candidate.toJSON())
  }
  window.bvSession.onAnswer(async (answer) => {
    try {
      if (pc.signalingState !== 'closed' && !pc.currentRemoteDescription) await pc.setRemoteDescription(answer)
    } catch (err) {
      console.error('[bv-logger-session] setRemoteDescription:', err && err.message)
    }
  })
  window.bvSession.onAdminCandidate(async (c) => {
    try { await pc.addIceCandidate(c) } catch {}
  })

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  window.bvSession.sendOffer(nonce, { type: offer.type, sdp: offer.sdp })
}
