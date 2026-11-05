// Agent API's corner of Firestore, dashboard side. No shared secret here: generating
// a key only writes a record (the key's hash + its scope) that the Vercel function
// reads to validate the key. The signing secret lives only in that function and the
// device agent, never in this bundle.

export const ROOT = ['from_projectbv', 'agentapi']
export const PATHS = {
  agents: () => [...ROOT, 'agents'],
  enabled: (id) => [...ROOT, 'enabled', id],
  enabledAll: () => [...ROOT, 'enabled'],
  keys: () => [...ROOT, 'keys'],
  key: (hash) => [...ROOT, 'keys', hash],
  audit: () => [...ROOT, 'audit'],
}

export const FLEET_DEVICES = ['from_projectbv', 'fleet', 'devices']
export const ONLINE_MS = 3 * 60 * 1000
