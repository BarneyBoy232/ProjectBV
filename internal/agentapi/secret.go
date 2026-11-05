// Package agentapi is the device side of the Agent API tool: a signed command bus
// over Firestore that lets an AI — connected through the Agent API Worker with an
// API key — run arbitrary admin actions on this machine with nobody signed in.
//
// It runs inside the projectBV service (LocalSystem, auto-start at boot), so every
// action it performs runs with full SYSTEM/administrator rights, headless, exactly
// the hands-off control the zero-touch rule is about.
//
// The security model is deliberately NOT the dashboard tools' model. Remote/Files/
// Monitor ship their shared secret inside the dashboard's client JS, so their real
// gate is the operator's Google identity (firestore.rules). The Agent API's secret
// (`token` below) lives ONLY in the device binary and the Agent API Worker — it is
// never served to a browser — so the HMAC signature is itself the unforgeable gate:
// only the Worker can mint a command this device will run. The operator still holds
// the master switch: a device does nothing until it is ARMED (its `enabled` doc,
// written only by an allow-listed operator in the dashboard).
package agentapi

// token is the Agent API's shared signing secret. Because its secrecy IS the whole
// security model (unlike the other tools, whose secret is only a second layer under
// identity), it is NOT hardcoded here: it is loaded at runtime from the gitignored
// embedded-config.json (field "agentApiToken", alongside the Tailscale key) and set
// via Configure() when the service starts. It signs every command this device
// accepts and is the AES-GCM key material (via SHA-256) for every sealed result. It
// MUST equal the Agent API Worker's AGENTAPI_TOKEN secret. Empty means the tool is
// inert — every command fails to verify — the correct fail-closed default.
var token string

// Configure sets the signing secret from the agent's config. Called once at startup,
// before Run.
func Configure(agentAPIToken string) { token = agentAPIToken }

// StorageBucket is the Firebase Storage bucket, same value as the web config's
// storageBucket (public, not a secret). Reserved for a future large-payload relay;
// v1 returns file bytes inline inside the sealed result and leans on exec for large
// payloads.
const StorageBucket = "runik-77e07.firebasestorage.app"
