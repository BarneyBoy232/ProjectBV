// BV Remote — device agent (Electron main process, no visible window).
//
// What this does in Phase 1:
//   • runs quietly in the tray on a fleet device,
//   • writes a presence heartbeat so the console knows this device is reachable,
//   • listens on the Firebase command bus and answers commands whose signature
//     proves the sender holds the shared secret.
//
// Phase 2 fills in the real command handlers (popup, apps, tabs, perf); Phase 3
// adds the live screen/control session. For now every command except `ping` replies
// "not implemented yet" so the wiring is provable end to end.
import os from 'node:os'
import { execFile } from 'node:child_process'
import { app, Tray, Menu, nativeImage } from 'electron'
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore'
import { db, PATHS, CMD, verifyCommand, deviceId } from './shared/index.js'
import { TOKEN } from './shared/secret.js'
import { showPopup } from './popup.js'
import { listProcs, killProc } from './procs.js'
import { listApps, launchApp } from './apps.js'
import { listTabs, openTab, closeTab, enableTabs } from './tabs.js'
import { snapshot } from './perf.js'
import { startLimitsWatch, getLimits, memoryVerdict } from './limits.js'
import { startSession, stopSession, isSessionActive } from './session.js'
import { setInputBlocked, isInputBlocked } from './blockinput.js'
import { startMonitorAgent } from './taskmgr/bus.js'
import { startLoggerAgent } from './logger/bus.js'

const ID = deviceId(os.hostname())
const HEARTBEAT_MS = 30 * 1000

// Only one agent per machine.
if (!app.requestSingleInstanceLock()) app.quit()

// A tray-only app must never quit just because it has no windows.
app.on('window-all-closed', () => {})

let tray = null

// Per-device on/off switch. The agent installs on every device but stays DORMANT
// (ignores all commands) until it's enabled from the console. Default: disabled.
let enabled = false

app.whenReady().then(() => {
  // Start automatically when the device logs in, so a deployed agent is always up.
  try { app.setLoginItemSettings({ openAtLogin: true }) } catch {}
  createTray()
  startEnabledWatch()
  startLimitsWatch()
  startHeartbeat()
  startCommandBus()
  // Monitor is a separate tool that happens to ship in this process. It has its
  // own bus, its own switch and its own presence, so it is handed the device id
  // and nothing else.
  startMonitorAgent(ID)
  // Logger is another separate tool in this process — its own bus, switch and
  // presence. It watches a device live (screen, mic, speaker output, keys/mouse)
  // and controls nothing.
  startLoggerAgent(ID)
  console.log(`[bv-agent] up as "${ID}"`)
})

// Watch this device's enable switch, set from the console.
function startEnabledWatch() {
  onSnapshot(
    doc(db(), ...PATHS.enabled(ID)),
    (snap) => {
      enabled = !!(snap.data() && snap.data().enabled)
      console.log('[bv-agent] enabled =', enabled)
    },
    (err) => {
      console.error('[bv-agent] enabled watch error, reconnecting:', err.message)
      setTimeout(startEnabledWatch, 5000)
    },
  )
}

// --- tray ----------------------------------------------------------------
// Placeholder 1x1 icon so Windows has something to show; replaced with the real
// brand mark in the Phase 4 design pass.
function createTray() {
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  )
  tray = new Tray(icon)
  tray.setToolTip(`BV Remote agent — ${ID}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Device: ${ID}`, enabled: false },
      { type: 'separator' },
      { label: 'Quit agent', click: () => app.quit() },
    ]),
  )
}

// --- presence heartbeat ---------------------------------------------------
function startHeartbeat() {
  const write = () =>
    setDoc(doc(db(), ...PATHS.agent(ID)), {
      host: ID,
      online: true,
      lastSeen: Date.now(),
      enabled, // whether this device is currently switched on for control
      // Capabilities this build supports — grows as phases land.
      caps: ['bus', 'popup', 'apps', 'tabs', 'perf', 'reboot', 'session', 'audio', 'lock', 'blockinput'],
      version: app.getVersion(),
    }).catch((e) => console.error('[bv-agent] heartbeat failed:', e.message))
  write()
  setInterval(write, HEARTBEAT_MS)
}

// --- command bus ----------------------------------------------------------
// Watch this device's command doc. When a NEW, correctly-signed command arrives,
// run it and write the result back.
let lastHandled = null

async function startCommandBus() {
  // Adopt whatever command is ALREADY in the doc as "already seen" without running
  // it. Firestore replays the last command on every (re)start; without this, an
  // agent restart would re-execute the last command — harmless for ping, dangerous
  // once Phase 2 adds kill/launch. Comparing ids (not timestamps) avoids any
  // clock-skew issues between operator and device.
  try {
    const existing = await getDoc(doc(db(), ...PATHS.command(ID)))
    if (existing.exists() && existing.data()?.id) lastHandled = existing.data().id
  } catch (e) {
    console.error('[bv-agent] could not read existing command:', e.message)
  }

  subscribe()
}

function subscribe() {
  onSnapshot(
    doc(db(), ...PATHS.command(ID)),
    async (snap) => {
      const cmd = snap.data()
      if (!cmd || !cmd.id || cmd.id === lastHandled) return

      // The gate: silently drop anything not signed with the shared secret.
      const ok = await verifyCommand(cmd, TOKEN).catch(() => false)
      if (!ok) {
        console.warn('[bv-agent] dropped command with bad/missing signature')
        return
      }
      // Dormant until enabled from the console — ignore every command.
      if (!enabled) {
        console.warn('[bv-agent] device disabled — ignoring command')
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
      }).catch((e) => console.error('[bv-agent] result write failed:', e.message))
    },
    (err) => {
      // A listener that errors is dead — log it and try to re-establish so the bus
      // doesn't go silently offline.
      console.error('[bv-agent] command listener error, reconnecting:', err.message)
      setTimeout(subscribe, 5000)
    },
  )
}

async function handle(cmd) {
  const a = cmd.args || {}
  switch (cmd.cmd) {
    case CMD.PING:
      return { ok: true, output: `pong from ${ID}` }
    case CMD.POPUP:
      return { ok: true, output: showPopup(a.text, a.seconds) }
    case CMD.LIST_PROCS:
      return { ok: true, output: await listProcs() }
    case CMD.KILL_PROC:
      return { ok: true, output: await killProc(a.pid) }
    case CMD.LIST_APPS:
      return { ok: true, output: await listApps() }
    case CMD.LAUNCH_APP:
      return { ok: true, output: await launchApp(a.path) }
    case CMD.LIST_TABS:
      return { ok: true, output: await listTabs() }
    case CMD.OPEN_TAB:
      return { ok: true, output: await openTab(a.url) }
    case CMD.CLOSE_TAB:
      return { ok: true, output: await closeTab(a.targetId) }
    case CMD.ENABLE_TABS:
      return { ok: true, output: await enableTabs() }
    case CMD.PERF: {
      const perf = await snapshot()
      // The verdict rides along with every perf reading, so the console can show
      // "this is close to the limit" while a session is running instead of only
      // finding out when the next one is refused.
      return { ok: true, output: { ...perf, sessionActive: isSessionActive(), limits: getLimits(), verdict: memoryVerdict(perf) } }
    }
    case CMD.REBOOT:
      // Short delay so the result can be written back before the machine goes down.
      // Await so a failure (e.g. no privilege) is reported as ok:false, not success.
      await new Promise((res, rej) =>
        execFile('shutdown', ['/r', '/t', '5', '/c', 'BV Remote: remote reboot'], { windowsHide: true }, (err) => (err ? rej(err) : res())),
      )
      return { ok: true, output: { rebooting: true } }
    case CMD.START_SESSION:
      return { ok: true, output: await startSession(ID, a.nonce) }
    case CMD.STOP_SESSION:
      // Never leave the person frozen out after the operator disconnects.
      if (isInputBlocked()) setInputBlocked(false)
      return { ok: true, output: await stopSession(a.nonce) }
    case CMD.BLOCK_INPUT:
      // Freeze or unfreeze the person sitting at the device. The console decides;
      // the agent guarantees it can never be left frozen (see blockinput.js).
      return { ok: true, output: setInputBlocked(!!a.on) }
    default:
      return { ok: false, output: `unknown command: ${cmd.cmd}` }
  }
}
