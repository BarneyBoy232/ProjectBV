// Agent API's view of the fleet, just enough to offer the device picker when
// generating a key. Arming is handled automatically by keys.js (invisible to the
// operator), so there is no arm UI here.
import { db } from '../../firebase'
import { collection, doc, getDocs, setDoc } from 'firebase/firestore'
import { PATHS, FLEET_DEVICES, ONLINE_MS } from './protocol'

function toMillis(v) {
  if (typeof v === 'number') return v
  if (v && typeof v.toMillis === 'function') return v.toMillis()
  return null
}

export async function loadDevices() {
  const [fleetSnap, agentSnap] = await Promise.all([
    getDocs(collection(db, ...FLEET_DEVICES)),
    getDocs(collection(db, ...PATHS.agents())),
  ])
  const agents = new Map()
  agentSnap.forEach((d) => agents.set(d.id, d.data()))
  const now = Date.now()
  const row = (id, fleet, a) => {
    const seen = a ? toMillis(a.lastSeen) : null
    return {
      id,
      name: (fleet && fleet.name) || (a && a.host) || id,
      hasAgent: !!a,
      agentOnline: !!(a && a.online && seen && now - seen < ONLINE_MS),
      agentLastSeen: seen,
      version: (a && a.version) || null,
    }
  }
  const rows = fleetSnap.docs.map((d) => row(d.id, d.data(), agents.get(d.id)))
  agentSnap.forEach((d) => {
    if (!rows.some((r) => r.id === d.id)) rows.push(row(d.id, null, d.data()))
  })
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

// Arm or disarm a device for the Agent API. The device ignores commands unless it is
// armed, so this is what makes a key take effect — set automatically when a key is
// generated, cleared by the kill switch. untilMs is an ABSOLUTE expiry (0 = never)
// matched to the key's own expiry.
export function setArmed(deviceId, on, untilMs = 0) {
  return setDoc(doc(db, ...PATHS.enabled(deviceId)), {
    enabled: !!on,
    ts: Date.now(),
    until: on ? (untilMs || 0) : 0,
  })
}
