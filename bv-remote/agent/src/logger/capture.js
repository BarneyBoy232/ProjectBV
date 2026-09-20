// Global keyboard + mouse capture (device side), for a live Logger session only.
//
// This is the exact mirror of ../input.js: input.js INJECTS the operator's events
// into this machine; this READS the real events the person at the machine is
// producing and hands them to the caller, which streams them to the dashboard.
//
// It uses uiohook-napi, an OS-level hook that sees input across every window. The
// hook needs no elevation to observe input. Capture is started when a session
// begins and stopped the moment it ends — nothing is recorded or kept.
//
// Loading is defensive: if the native module is missing on a device, a session
// still streams screen + audio, and the key/mouse feed is simply empty rather than
// crashing the whole session.

let hook = null // the uIOhook singleton, once loaded
let Key = null // UiohookKey (name -> numeric code)
let codeToName = null // reverse map, numeric code -> readable name
let running = false
let sink = null // the callback events are handed to
let lastMove = 0 // throttle clock for mousemove

// uiohook mouse button numbers -> readable names.
const BUTTON = { 1: 'left', 2: 'right', 3: 'middle', 4: 'x1', 5: 'x2' }

// Build a numeric-code -> name lookup from UiohookKey once, so a keystroke can be
// shown as "A" / "Enter" / "Shift" rather than a raw scan code.
function buildKeyNames(UiohookKey) {
  const m = {}
  for (const [name, code] of Object.entries(UiohookKey)) {
    if (typeof code === 'number' && !(code in m)) m[code] = name
  }
  return m
}

async function load() {
  if (hook) return true
  try {
    const mod = await import('uiohook-napi')
    hook = mod.uIOhook
    Key = mod.UiohookKey
    codeToName = buildKeyNames(Key)
    return true
  } catch (e) {
    console.error('[bv-logger] input capture unavailable:', e && e.message)
    return false
  }
}

function emit(evt) {
  if (sink) {
    try { sink(evt) } catch {}
  }
}

const onKeyDown = (e) => emit({ t: 'k', a: 'down', name: codeToName[e.keycode] || `#${e.keycode}` })
const onKeyUp = (e) => emit({ t: 'k', a: 'up', name: codeToName[e.keycode] || `#${e.keycode}` })
const onMouseMove = (e) => {
  // The pointer moves far too often to send every sample; ~20/s is smooth enough
  // to follow on the dashboard and keeps the data channel light.
  const now = Date.now()
  if (now - lastMove < 50) return
  lastMove = now
  emit({ t: 'm', x: e.x, y: e.y })
}
const onMouseDown = (e) => emit({ t: 'd', b: BUTTON[e.button] || String(e.button) })
const onMouseUp = (e) => emit({ t: 'u', b: BUTTON[e.button] || String(e.button) })
const onWheel = (e) => emit({ t: 'w', dy: Math.sign(e.rotation || e.direction || 0) })

// Start capturing and hand every event to `cb`. Safe to call when already running.
export async function startCapture(cb) {
  sink = cb
  if (running) return
  if (!(await load())) return // no native module — screen + audio still stream
  hook.on('keydown', onKeyDown)
  hook.on('keyup', onKeyUp)
  hook.on('mousemove', onMouseMove)
  hook.on('mousedown', onMouseDown)
  hook.on('mouseup', onMouseUp)
  hook.on('wheel', onWheel)
  try {
    hook.start()
    running = true
  } catch (e) {
    console.error('[bv-logger] could not start input hook:', e && e.message)
  }
}

// Stop capturing and drop every listener. Called the instant a session ends.
export function stopCapture() {
  sink = null
  if (!hook || !running) { running = false; return }
  try {
    hook.off('keydown', onKeyDown)
    hook.off('keyup', onKeyUp)
    hook.off('mousemove', onMouseMove)
    hook.off('mousedown', onMouseDown)
    hook.off('mouseup', onMouseUp)
    hook.off('wheel', onWheel)
    hook.stop()
  } catch (e) {
    console.error('[bv-logger] could not stop input hook:', e && e.message)
  }
  running = false
}
