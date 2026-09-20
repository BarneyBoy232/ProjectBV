// Who is allowed to use the console, and what they can see.
//
// Identity is a verified Google account (Firebase Auth). Authorisation is the
// live allow-list at from_projectbv/access/members/{email}, editable only by the
// root admin. The root admin is hardcoded so there is always one account that can
// rebuild the list — it matches the same constant in firestore.rules.
import { db } from './firebase'
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc } from 'firebase/firestore'

export const ROOT_EMAIL = 'ethan.barnacoat@gmail.com'

const membersCol = () => collection(db, 'from_projectbv', 'access', 'members')
const memberDoc = (email) => doc(db, 'from_projectbv', 'access', 'members', email)

// Resolve a signed-in Google user to their access. Returns:
//   { allowed, role: 'admin'|'viewer', devices: 'all' | [ids], email }
// The root admin is always an allowed admin who sees every device, even with no
// member document. A verified account that is not the root and not listed is
// denied. An unverified account is never allowed.
export async function resolveAccess(user) {
  if (!user || !user.email || !user.emailVerified) {
    return { allowed: false, role: null, devices: [], email: user?.email || null }
  }
  const email = user.email.toLowerCase()
  if (email === ROOT_EMAIL) {
    return { allowed: true, role: 'admin', devices: 'all', email }
  }
  try {
    const snap = await getDoc(memberDoc(email))
    if (!snap.exists()) return { allowed: false, role: null, devices: [], email }
    const d = snap.data() || {}
    const role = d.role === 'admin' ? 'admin' : 'viewer'
    const devices = role === 'admin' ? 'all' : Array.isArray(d.devices) ? d.devices : []
    return { allowed: true, role, devices, email }
  } catch {
    // A permission error means the rules refused the read — i.e. not allow-listed.
    return { allowed: false, role: null, devices: [], email }
  }
}

// Does this access let the operator act on a given device id? Admins: every
// device. Viewers: only the ids assigned to them.
export function canSeeDevice(access, deviceId) {
  if (!access || !access.allowed) return false
  if (access.devices === 'all') return true
  return Array.isArray(access.devices) && access.devices.includes(deviceId)
}

// ---- allow-list management (root admin only; rules enforce it) -------------

export async function listMembers() {
  const snap = await getDocs(membersCol())
  return snap.docs.map((d) => ({ email: d.id, ...d.data() }))
}

// devices: 'all' for an admin, or an array of device ids for a scoped viewer.
export async function setMember(email, role, devices) {
  const clean = String(email || '').trim().toLowerCase()
  if (!clean || !clean.includes('@')) throw new Error('Enter a valid email.')
  if (clean === ROOT_EMAIL) throw new Error('The root admin is fixed and cannot be edited here.')
  await setDoc(memberDoc(clean), {
    role: role === 'admin' ? 'admin' : 'viewer',
    devices: role === 'admin' ? 'all' : Array.isArray(devices) ? devices : [],
    ts: Date.now(),
  })
}

export async function removeMember(email) {
  const clean = String(email || '').trim().toLowerCase()
  if (clean === ROOT_EMAIL) throw new Error('The root admin cannot be removed.')
  await deleteDoc(memberDoc(clean))
}
