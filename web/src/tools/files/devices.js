// Files' own view of the fleet.
//
// Reads the projectBV fleet heartbeat (so a device appears the moment projectBV
// knows about it) and joins it to Files' own presence documents and switches. It
// never touches Remote's or Monitor's collections: a device can be on for Files
// and off for the others, and no tool's state describes another's.
import { db } from '../../firebase'
import { collection, doc, getDocs, setDoc } from 'firebase/firestore'
import { PATHS, FLEET_DEVICES, ONLINE_MS } from './protocol'
import { loadRemoteKnownDevices } from '../../fleet'

function toMillis(v) {
  if (typeof v === 'number') return v
  if (v && typeof v.toMillis === 'function') return v.toMillis()
  return null
}

export async function loadDevices() {
  const [fleetSnap, agentSnap, switchSnap, labelSnap, remoteKnown] = await Promise.all([
    getDocs(collection(db, ...FLEET_DEVICES)),
    getDocs(collection(db, ...PATHS.agents())),
    getDocs(collection(db, ...PATHS.enabledAll())),
    getDocs(collection(db, 'from_projectbv', 'fleet', 'labels')),
    loadRemoteKnownDevices(),
  ])

  const agents = new Map()
  agentSnap.forEach((d) => agents.set(d.id, d.data()))
  const switches = new Map()
  switchSnap.forEach((d) => switches.set(d.id, !!(d.data() || {}).enabled))
  const labels = new Map(labelSnap.docs.map((d) => [d.id, (d.data() || {}).label || '']))

  const now = Date.now()
  // The switch is the operator's stated intent and wins. The agent's own `enabled`
  // is only what it last knew, used where no switch has ever been set.
  const isOn = (id, a) => (switches.has(id) ? switches.get(id) : !!(a && a.enabled))

  const row = (id, fleet, a, known) => {
    const seen = a ? toMillis(a.lastSeen) : null
    return {
      id,
      name: labels.get(id) || (fleet && fleet.name) || (a && a.host) || (known && known.host) || id,
      fleetOnline: !!(fleet && toMillis(fleet.lastSeen) && now - toMillis(fleet.lastSeen) < ONLINE_MS),
      // "Has a Files agent" is a fact about THIS tool. An agent build from before
      // Files existed writes nothing here, which is how the dashboard tells
      // "not supported on that device" from "supported but not answering".
      hasAgent: !!a,
      agentOnline: !!(a && a.online && seen && now - seen < ONLINE_MS),
      agentLastSeen: seen,
      version: (a && a.version) || null,
      enabled: isOn(id, a),
    }
  }

  const rows = fleetSnap.docs.map((d) => row(d.id, d.data(), agents.get(d.id)))
  agentSnap.forEach((d) => {
    if (!rows.some((r) => r.id === d.id)) rows.push(row(d.id, null, d.data()))
  })
  // A device the BV Remote agent knows but Files' own agent has never reported: show
  // it (as "needs agent update") rather than hiding a machine you can already reach
  // from the Remote tool.
  remoteKnown.forEach((known, id) => {
    if (!rows.some((r) => r.id === id)) rows.push(row(id, null, null, known))
  })
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

// Turn Files on or off for one device. The agent installs everywhere and stays
// dormant until this says otherwise.
export function setEnabled(deviceId, on) {
  return setDoc(doc(db, ...PATHS.enabled(deviceId)), { enabled: !!on, ts: Date.now() })
}
