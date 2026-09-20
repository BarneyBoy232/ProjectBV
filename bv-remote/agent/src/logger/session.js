// Live watch session, Logger agent side (main process).
//
// The observe-only twin of ../session.js. A session runs in a hidden renderer
// window (session.html) that captures the screen + speaker output + microphone and
// runs WebRTC. This module owns that window's lifecycle, relays the WebRTC
// signalling through Firestore under Logger's own partition (SIGNED with Logger's
// secret so a Firestore reader can't hijack it), and pumps the OS-level
// keyboard/mouse capture out to the renderer's data channel.
//
// It never injects input — there is no path here that drives the machine.
import { BrowserWindow, desktopCapturer, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { doc, setDoc, onSnapshot, collection, addDoc, getDocs, deleteDoc } from 'firebase/firestore'
import { db } from '../shared/firebase.js'
import { PATHS, signBlob, verifyBlob } from './protocol.js'
import { snapshot } from '../perf.js'
import { memoryVerdict } from '../limits.js'
import { startCapture, stopCapture } from './capture.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// What a Logger session captures. Fixed for now — the tool is "watch this device
// fully" — but kept as an object so a future "screen only" mode is a one-line change.
const CAPS = { mic: true, systemAudio: true, capture: true }

let win = null
let unsubAnswer = null
let unsubAdminCands = null
let active = false
let starting = false
let currentNonce = null
let deviceId = null
let fpsTimer = null

// The framerate governor — identical policy to the Remote session: hold the whole
// machine under 80% CPU, easing the live framerate down when it's busy and back up
// when there's room.
const CPU_CEILING = 80
const CPU_HEADROOM = 65
const FPS_MAX = 60
const FPS_MIN = 15

function startGovernor() {
  stopGovernor()
  let targetFps = FPS_MAX
  const tick = async () => {
    if (!active || !win || win.isDestroyed()) return
    try {
      const s = await snapshot()
      if (s.cpuPct >= CPU_CEILING && targetFps > FPS_MIN) targetFps = Math.max(FPS_MIN, targetFps - 10)
      else if (s.cpuPct <= CPU_HEADROOM && targetFps < FPS_MAX) targetFps = Math.min(FPS_MAX, targetFps + 5)
      if (win && !win.isDestroyed()) win.webContents.send('bvlog:set-fps', targetFps)
    } catch {}
    fpsTimer = setTimeout(tick, 2000)
  }
  tick()
}

function stopGovernor() {
  if (fpsTimer) { clearTimeout(fpsTimer); fpsTimer = null }
}

export function isSessionActive() {
  return active
}

export async function startSession(id, nonce) {
  if (starting) return { started: false, reason: 'already starting' }
  starting = true
  try {
    // The same memory gate as Remote, checked BEFORE the capture window exists:
    // refusing here costs a message; refusing after has already taken the memory.
    const verdict = memoryVerdict(await snapshot())
    if (!verdict.ok) {
      starting = false
      const e = new Error(`Not streaming — ${verdict.reason}.`)
      e.verdict = verdict
      throw e
    }
    deviceId = id
    if (win && !win.isDestroyed()) await teardownWindow()
    currentNonce = nonce
    active = true

    win = new BrowserWindow({
      width: 320,
      height: 200,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'session-preload.cjs'),
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    await win.loadFile(path.join(__dirname, 'session.html'))

    await clearCandidates(id).catch(() => {})
    win.webContents.send('bvlog:start', { nonce, caps: CAPS })
    startGovernor()

    // Start the OS-level input capture and pump each event to the renderer, which
    // forwards it over the WebRTC `capture` channel. Stopped again in teardown.
    if (CAPS.capture) {
      startCapture((evt) => {
        if (win && !win.isDestroyed()) win.webContents.send('bvlog:capture', evt)
      })
    }

    unsubAnswer = onSnapshot(doc(db(), ...PATHS.session(id)), async (snap) => {
      const d = snap.data()
      if (!d || d.nonce !== nonce || !d.answer || !win || win.isDestroyed()) return
      if (await verifyBlob({ nonce, answer: d.answer }, d.answerSig)) {
        win.webContents.send('bvlog:answer', d.answer)
      } else {
        console.warn('[bv-logger] dropped answer with bad signature')
      }
    })

    const seen = new Set()
    unsubAdminCands = onSnapshot(collection(db(), ...PATHS.adminCandidates(id)), (snap) => {
      snap.docChanges().forEach(async (ch) => {
        if (ch.type !== 'added' || seen.has(ch.doc.id)) return
        seen.add(ch.doc.id)
        const c = ch.doc.data()
        if (c.nonce !== nonce || !win || win.isDestroyed()) return
        if (await verifyBlob({ nonce, candidate: c.candidate }, c.sig)) {
          win.webContents.send('bvlog:admin-candidate', c.candidate)
        }
      })
    })

    return { started: true }
  } finally {
    starting = false
  }
}

export async function stopSession(nonce) {
  if (nonce && currentNonce && nonce !== currentNonce) return { stopped: false, reason: 'nonce mismatch' }
  active = false
  await teardownWindow()
  if (deviceId) {
    await setDoc(doc(db(), ...PATHS.session(deviceId)), { active: false, ts: Date.now() }, { merge: true }).catch(() => {})
    await clearCandidates(deviceId).catch(() => {})
  }
  currentNonce = null
  return { stopped: true }
}

function teardownWindow() {
  stopGovernor()
  stopCapture()
  if (unsubAnswer) { unsubAnswer(); unsubAnswer = null }
  if (unsubAdminCands) { unsubAdminCands(); unsubAdminCands = null }
  if (win && !win.isDestroyed()) win.close()
  win = null
}

async function clearCandidates(id) {
  for (const p of [PATHS.adminCandidates(id), PATHS.deviceCandidates(id)]) {
    const snap = await getDocs(collection(db(), ...p)).catch(() => null)
    if (snap) await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})))
  }
}

// --- IPC from the Logger session renderer --------------------------------
// Namespaced `bvlog:` so the Remote session's identically-shaped handlers, alive
// in the same process, never fire for these and vice versa.
ipcMain.handle('bvlog:get-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'] })
  return sources[0] ? { id: sources[0].id } : null
})
ipcMain.on('bvlog:offer', async (_e, { nonce, offer }) => {
  if (nonce !== currentNonce || !deviceId) return
  const sig = await signBlob({ nonce, offer })
  await setDoc(doc(db(), ...PATHS.session(deviceId)), { nonce, offer, offerSig: sig, active: true, ts: Date.now() }, { merge: true }).catch((err) =>
    console.error('[bv-logger] offer write:', err.message),
  )
})
ipcMain.on('bvlog:device-candidate', async (_e, { nonce, candidate }) => {
  if (nonce !== currentNonce || !deviceId) return
  const sig = await signBlob({ nonce, candidate })
  await addDoc(collection(db(), ...PATHS.deviceCandidates(deviceId)), { nonce, candidate, sig, ts: Date.now() }).catch(() => {})
})
