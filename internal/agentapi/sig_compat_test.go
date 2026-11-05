package agentapi

import "testing"

// Tests run with a throwaway signing token (NOT a real secret — production loads the
// real one from embedded-config.json via Configure). The pinned signature below was
// computed by the Worker's JS commandSig from exactly this token and command.
func init() { token = "test-signing-token-not-a-real-secret" }

// TestSigCompat pins the cross-language signing contract: the signature below was
// produced by the Agent API Worker's JS (agent-api/src/crypto.js commandSig) for
// the exact command fields here. The Go verifier MUST accept it, or a command the
// Worker signs would never run on the device. The arg types mirror what
// internal/firestore decodes a stored command into (numbers -> int64, a string
// array -> []string).
//
// If this ever fails, the two stable()/HMAC implementations have drifted — fix
// them together, do not just update the constant.
func TestSigCompat(t *testing.T) {
	args := map[string]any{
		"shell":     "powershell",
		"line":      "echo hi",
		"args":      []string{"a", "b"},
		"timeoutMs": int64(120000),
	}
	const (
		id  = "abc-1-xyz"
		cmd = "exec"
		ts  = int64(1730800000000)
		sig = "83664d2d4c396d5e2cdae7742a47161514fcb51cb5a89d3839db31fc083687d7"
	)
	if !verifyCommand(id, cmd, ts, args, sig) {
		t.Fatalf("Go verifier rejected the Worker-produced signature — stable()/HMAC have drifted")
	}
	// A tampered arg must NOT verify against the same signature.
	args["line"] = "echo HACKED"
	if verifyCommand(id, cmd, ts, args, sig) {
		t.Fatalf("signature verified after args were tampered — verification is broken")
	}
}
