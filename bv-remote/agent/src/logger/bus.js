// Logger's device-side front door: presence, its own on/off switch, and its own
// command bus — deliberately separate from Remote and Monitor.
//
// Logger ships in the same agent process but is its own tool: separately
// switchable, separately visible as online or not, and unable to be driven by
// anything holding another tool's secret. It stays dormant until it is turned on
// for this device from the Logger tool.
import { app } from 'electron'
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore'
import { db } from '../shared/firebase.js'
import { PATHS, CMD, verifyCommand } from './protocol.js'
import { snapshot } from '../perf.js'
import { getLimits, memoryVerdict } from '../limits.js'
import { startSession, stopSession, isSessionActive } from './session.js'

const HEARTBEAT_MS = 30 * 1000

let ID = null
let enabled = false
let lastHandled = null

export function isEnabled() { return enabled }

export function startLoggerAgent(deviceId) {
  ID = deviceId
  watchSwitch()
  heartbeat()
  commandBus()
  console.log(`[bv-logger] up as "${ID}"`)
}

// Logger installs everywhere the agent does but stays dormant until it is turned
// on for this device, from the Logger tool — not from Remote's or Monitor's switch.
function watchSwitch() {
  onSnapshot(
    doc(db(), ...PATHS.enabled(ID)),
    (snap) => {
      enabled = !!(snap.data() && snap.data().enabled)
      console.log('[bv-logger] enabled =', enabled)
      // Turning the tool off for a device ends any watch already open on it.
      if (!enabled && isSessionActive()) stopSession().catch(() => {})
    },
    (err) => {
      console.error('[bv-logger] switch watch error, reconnecting:', err.message)
      setTimeout(watchSwitch, 5000)
    },
  )
}

// Logger's own presence. A device can be online for Remote and silent for Logger —
// an older agent build has no Logger in it at all — and the dashboard has to tell
// those apart before it waits on a reply that never comes.
function heartbeat() {
  const write = () =>
    setDoc(doc(db(), ...PATHS.agent(ID)), {
      host: ID,
      online: true,
      lastSeen: Date.now(),
      enabled,
      streaming: isSessionActive(),
      caps: ['screen', 'mic', 'systemAudio', 'inputCapture'],
      version: app.getVersion(),
    }).catch((e) => console.error('[bv-logger] heartbeat failed:', e.message))
  write()
  setInterval(write, HEARTBEAT_MS)
}

async function commandBus() {
  // Firestore replays whatever is already in the document on every (re)start.
  // Adopting it as seen means an agent restart never re-runs the last command.
  try {
    const existing = await getDoc(doc(db(), ...PATHS.command(ID)))
    if (existing.exists() && existing.data()?.id) lastHandled = existing.data().id
  } catch (e) {
    console.error('[bv-logger] could not read existing command:', e.message)
  }
  subscribe()
}

function subscribe() {
  onSnapshot(
    doc(db(), ...PATHS.command(ID)),
    async (snap) => {
      const cmd = snap.data()
      if (!cmd || !cmd.id || cmd.id === lastHandled) return

      if (!(await verifyCommand(cmd).catch(() => false))) {
        console.warn('[bv-logger] dropped command with bad/missing signature')
        return
      }
      if (!enabled) {
        console.warn('[bv-logger] device switched off — ignoring command')
        lastHandled = cmd.id
        return
      }
      lastHandled = cmd.id
      const result = await handle(cmd).catch((e) => ({ ok: false, output: e.message }))
      await setDoc(doc(db(), ...PATHS.result(ID)), {
        id: cmd.id,
        ok: !!result.ok,
        output: result.output ?? null,
        ts: Date.now(),
      }).catch((e) => console.error('[bv-logger] result write failed:', e.message))
    },
    (err) => {
      console.error('[bv-logger] command listener error, reconnecting:', err.message)
      setTimeout(subscribe, 5000)
    },
  )
}

async function handle(cmd) {
  const a = cmd.args || {}
  switch (cmd.cmd) {
    case CMD.PING:
      return { ok: true, output: `pong from ${ID}` }
    case CMD.PERF: {
      const perf = await snapshot()
      // The verdict rides along with every perf reading, so the dashboard can show
      // "close to the limit" while a session runs, not only when the next is refused.
      return { ok: true, output: { ...perf, sessionActive: isSessionActive(), limits: getLimits(), verdict: memoryVerdict(perf) } }
    }
    case CMD.START_SESSION:
      return { ok: true, output: await startSession(ID, a.nonce) }
    case CMD.STOP_SESSION:
      return { ok: true, output: await stopSession(a.nonce) }
    default:
      return { ok: false, output: `unknown command: ${cmd.cmd}` }
  }
}
