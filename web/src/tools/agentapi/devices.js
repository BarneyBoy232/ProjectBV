// Agent API's view of the fleet: the projectBV heartbeat joined to this tool's own
// presence + arm switches. Arming a device (setEnabled) is the master control that
// lets the AI touch it at all; it is an operator-identity write, enforced by rules.
import { db } from '../../firebase'
import { collection, doc, getDocs, setDoc } from 'firebase/firestore'
import { PATHS, FLEET_DEVICES, ONLINE_MS } from './protocol'

function toMillis(v) {
  if (typeof v === 'number') return v
  if (v && typeof v.toMillis === 'function') return v.toMillis()
  return null
}

export async function loadDevices() {
  const [fleetSnap, agentSnap, switchSnap, labelSnap] = await Promise.all([
    getDocs(collection(db, ...FLEET_DEVICES)),
    getDocs(collection(db, ...PATHS.agents())),
    getDocs(collection(db, ...PATHS.enabledAll())),
    getDocs(collection(db, 'from_projectbv', 'fleet', 'labels')),
  ])

  const agents = new Map()
  agentSnap.forEach((d) => agents.set(d.id, d.data()))
  const switches = new Map()
  switchSnap.forEach((d) => switches.set(d.id, d.data() || {}))
  const labels = new Map(labelSnap.docs.map((d) => [d.id, (d.data() || {}).label || '']))

  const now = Date.now()
  // The switch doc is the operator's stated intent and wins; an auto-expiry that has
  // passed counts as disarmed, matching what the device itself now does.
  const armState = (id, a) => {
    const s = switches.get(id)
    const enabled = s ? !!s.enabled : !!(a && a.enabled)
    const until = s && typeof s.until === 'number' ? s.until : 0
    if (!enabled || (until > 0 && now > until)) return { armed: false, until }
    return { armed: true, until }
  }

  const row = (id, fleet, a) => {
    const seen = a ? toMillis(a.lastSeen) : null
    const arm = armState(id, a)
    return {
      id,
      name: labels.get(id) || (fleet && fleet.name) || (a && a.host) || id,
      fleetOnline: !!(fleet && toMillis(fleet.lastSeen) && now - toMillis(fleet.lastSeen) < ONLINE_MS),
      hasAgent: !!a,
      agentOnline: !!(a && a.online && seen && now - seen < ONLINE_MS),
      agentLastSeen: seen,
      version: (a && a.version) || null,
      armed: arm.armed,
      armedUntil: arm.until,
    }
  }

  const rows = fleetSnap.docs.map((d) => row(d.id, d.data(), agents.get(d.id)))
  agentSnap.forEach((d) => {
    if (!rows.some((r) => r.id === d.id)) rows.push(row(d.id, null, d.data()))
  })
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

// Arm or disarm a device for the Agent API. A disarmed device ignores every command
// the AI sends, so this is also the instant kill switch. durationMs > 0 arms with an
// auto-expiry so a hands-off fleet doesn't stay armed indefinitely; 0 means no expiry.
export function setArmed(deviceId, on, durationMs = 0) {
  return setDoc(doc(db, ...PATHS.enabled(deviceId)), {
    enabled: !!on,
    ts: Date.now(),
    until: on && durationMs > 0 ? Date.now() + durationMs : 0,
  })
}
