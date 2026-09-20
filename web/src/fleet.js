// The devices the console knows about beyond what THIS tool's own agent has
// reported. The BV Remote agent's presence is the canonical "this machine exists
// and runs our agent" signal, so every tool seeds its device list from it — a
// machine you can already control must never look absent the moment you open Task
// Manager, Logger or Files. Read-only; each tool still decides on its own whether
// it has a working agent there.
import { db } from './firebase'
import { collection, getDocs } from 'firebase/firestore'

const REMOTE_AGENTS = ['from_projectbv', 'remotedesk', 'agents']
const ONLINE_MS = 3 * 60 * 1000

function toMillis(v) {
  if (typeof v === 'number') return v
  if (v && typeof v.toMillis === 'function') return v.toMillis()
  return null
}

// Map<deviceId, { id, host, online, lastSeen }> — every device the Remote agent has
// ever checked in from. A tool merges these in as devices it can see but not yet act
// on, shown as "needs agent update" until its own build reaches them.
export async function loadRemoteKnownDevices() {
  const snap = await getDocs(collection(db, ...REMOTE_AGENTS))
  const now = Date.now()
  const out = new Map()
  snap.forEach((d) => {
    const a = d.data() || {}
    const seen = toMillis(a.lastSeen)
    out.set(d.id, { id: d.id, host: a.host || d.id, online: !!(a.online && seen && now - seen < ONLINE_MS), lastSeen: seen })
  })
  return out
}
