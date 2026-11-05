package agentapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"testing"
)

// sign reproduces the Worker's commandSig so the test can mint commands the device
// will accept, then prove the replay defences reject the ones they must.
func sign(id, cmd string, ts int64, args map[string]any) string {
	msg := fmt.Sprintf("%s|%s|%d|%s", id, cmd, ts, stable(args))
	mac := hmac.New(sha256.New, []byte(token))
	mac.Write([]byte(msg))
	return hex.EncodeToString(mac.Sum(nil))
}

// TestReplayGuard pins the fix for the blocker found in review: a captured command
// re-written to the world-writable bus must not re-run. handle() must reject a bad
// signature, a stale command, and — the real hole — a validly signed command whose
// timestamp is not strictly newer than the last one already run.
func TestReplayGuard(t *testing.T) {
	ctx := context.Background()
	lg := log.New(io.Discard, "", 0)
	now := nowMillis()
	mk := func(id string, ts int64) command {
		args := map[string]any{}
		return command{ID: id, Cmd: cmdInfo, TS: ts, Args: args, Sig: sign(id, cmdInfo, ts, args)}
	}

	// Fresh and above the floor (0): runs.
	if _, ok := handle(ctx, mk("c1", now), 0, lg); !ok {
		t.Fatal("a fresh, correctly signed command was rejected")
	}
	// Older than the floor: the actual replay — must be refused.
	if _, ok := handle(ctx, mk("c2", now-1000), now, lg); ok {
		t.Fatal("a replayed (older-ts) command was accepted")
	}
	// Equal to the floor: also refused (strictly-newer rule).
	if _, ok := handle(ctx, mk("c3", now), now, lg); ok {
		t.Fatal("a command with ts equal to the floor was accepted")
	}
	// Outside the freshness window, even with no floor: refused.
	if _, ok := handle(ctx, mk("c4", now-6*60*1000), 0, lg); ok {
		t.Fatal("a stale command was accepted")
	}
	// Tampered signature: refused.
	bad := mk("c5", now+1)
	bad.Sig = "deadbeef"
	if _, ok := handle(ctx, bad, 0, lg); ok {
		t.Fatal("a command with a bad signature was accepted")
	}
}
