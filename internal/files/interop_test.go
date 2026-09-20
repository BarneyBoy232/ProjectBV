package files

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// These fixed values were produced by the dashboard's own crypto (Node running the
// exact code in web/src/tools/files/protocol.js and data.js). If either side's
// signing or sealing drifts, this test fails — which is the whole point: the two
// programs must agree byte for byte.

func TestVerifyCommandMatchesDashboard(t *testing.T) {
	const sig = "e943a902f670f57e74059cb6d43af891d40ee2c90c552fbc1ab9970a78e0ebb8"
	args := map[string]any{"path": "C:Usersme & co <x>"}
	if !verifyCommand("abc-1-xyz", "list", 1737000000000, args, sig) {
		t.Fatalf("Go rejected a signature the dashboard produced — signing has drifted")
	}
	// A tampered arg must fail.
	if verifyCommand("abc-1-xyz", "list", 1737000000000, map[string]any{"path": "C:\\Windows"}, sig) {
		t.Fatalf("Go accepted a signature for different args")
	}
}

func TestOpenDashboardSealedBlob(t *testing.T) {
	const box = "FZS/39+qCjrrb9eOZxrGGudBY1HqfpMx0xjiWP3z52f+4veqaWR18a2wA66dIcc+HJrwy3ih1Qtz"
	raw, err := base64.StdEncoding.DecodeString(box)
	if err != nil {
		t.Fatalf("bad base64: %v", err)
	}
	plain, err := openBytes(raw)
	if err != nil {
		t.Fatalf("Go could not open a blob the dashboard sealed: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(plain, &m); err != nil {
		t.Fatalf("unsealed content is not the JSON we sent: %v", err)
	}
	if m["hello"] != "from-js" {
		t.Fatalf("unsealed content wrong: %v", m)
	}
}

func TestSealRoundTrip(t *testing.T) {
	msg := []byte(`{"ok":true,"entries":[{"name":"secret.txt"}]}`)
	b64, err := seal(msg)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.StdEncoding.DecodeString(b64)
	back, err := openBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	if string(back) != string(msg) {
		t.Fatalf("round trip mismatch: %s", back)
	}
}
