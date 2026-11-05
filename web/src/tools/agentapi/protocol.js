// Agent API's corner of Firestore, dashboard side. NOTE: there is deliberately NO
// shared secret here. This tool's signing secret lives only in the device binary
// and the Agent API Worker — never in this bundle — so the dashboard can arm a
// device and read presence, but it cannot itself sign a command. Minting keys and
// reading the audit log go through the Worker (see worker.js).

export const ROOT = ['from_projectbv', 'agentapi']
export const PATHS = {
  agents: () => [...ROOT, 'agents'],
  enabled: (id) => [...ROOT, 'enabled', id],
  enabledAll: () => [...ROOT, 'enabled'],
}

export const FLEET_DEVICES = ['from_projectbv', 'fleet', 'devices']
export const ONLINE_MS = 3 * 60 * 1000
