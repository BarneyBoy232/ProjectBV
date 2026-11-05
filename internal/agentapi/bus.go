package agentapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"projectbv/internal/config"
	"projectbv/internal/firestore"
)

const (
	pollEvery     = 2 * time.Second
	presenceEvery = 45 * time.Second
	enabledEvery  = 10 * time.Second
	// maxCommandAge is how far a command's signed timestamp may be from now (either
	// direction, to tolerate clock skew) before the device refuses it as a possible
	// replay. See handle().
	maxCommandAge = int64(5 * 60 * 1000)
)

// Run is the Agent API device loop: it announces presence, honours the master arm
// switch, and services one signed command at a time. It blocks until ctx is
// cancelled and never returns an error — a failure is logged and the loop goes on.
func Run(ctx context.Context, fs *firestore.Client, hc *http.Client, deviceID, host string, logger *log.Logger) {
	logger.Printf("agentapi: started for device %q", deviceID)
	if token == "" {
		logger.Printf("agentapi: no agentApiToken configured — tool is inert (every command fails to verify). Set agentApiToken in embedded-config.json.")
	}

	enabled := readEnabled(ctx, fs, deviceID)
	writePresence(ctx, fs, deviceID, host, enabled)

	// Skip whatever command is already sitting there from a previous session, so a
	// restart never re-runs a stale action — and seed the replay floor (lastHandledTS)
	// from it, so a command no newer than the last one we ran can never be accepted.
	lastHandled, lastHandledTS := "", int64(0)
	if c, ok := readCommand(ctx, fs, deviceID); ok {
		lastHandled, lastHandledTS = c.ID, c.TS
	}

	poll := time.NewTicker(pollEvery)
	presence := time.NewTicker(presenceEvery)
	enabledTick := time.NewTicker(enabledEvery)
	defer poll.Stop()
	defer presence.Stop()
	defer enabledTick.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-presence.C:
			writePresence(ctx, fs, deviceID, host, enabled)
		case <-enabledTick.C:
			enabled = readEnabled(ctx, fs, deviceID)
		case <-poll.C:
			if !enabled {
				continue
			}
			cmd, ok := readCommand(ctx, fs, deviceID)
			if !ok || cmd.ID == "" || cmd.ID == lastHandled {
				continue
			}
			out, accepted := handle(ctx, cmd, lastHandledTS, logger)
			lastHandled = cmd.ID // seen now, ran or not, so it isn't re-evaluated every poll
			if accepted {
				if cmd.TS > lastHandledTS {
					lastHandledTS = cmd.TS
				}
				writeResult(ctx, fs, deviceID, cmd.ID, out, logger)
			}
		}
	}
}

// --- presence + arm switch -------------------------------------------------
func writePresence(ctx context.Context, fs *firestore.Client, deviceID, host string, enabled bool) {
	_ = fs.Set(ctx, agentDoc(deviceID), map[string]any{
		"online":   true,
		"host":     host,
		"version":  config.Version,
		"enabled":  enabled,
		"lastSeen": nowMillis(),
	})
}

func readEnabled(ctx context.Context, fs *firestore.Client, deviceID string) bool {
	d, err := fs.Get(ctx, enabledDoc(deviceID))
	if err != nil || d == nil {
		return false
	}
	on, _ := d["enabled"].(bool)
	if !on {
		return false
	}
	// Auto-expiring arm: the operator can arm a device for a set time so a fleet is
	// never left armed indefinitely after a hands-off task. until == 0 means no expiry.
	if until := i64(d["until"]); until > 0 && nowMillis() > until {
		return false
	}
	return true
}

// --- the command -----------------------------------------------------------
type command struct {
	ID   string
	Cmd  string
	TS   int64
	Args map[string]any
	Sig  string
}

func readCommand(ctx context.Context, fs *firestore.Client, deviceID string) (command, bool) {
	d, err := fs.Get(ctx, commandDoc(deviceID))
	if err != nil || d == nil {
		return command{}, false
	}
	c := command{}
	c.ID, _ = d["id"].(string)
	c.Cmd, _ = d["cmd"].(string)
	c.Sig, _ = d["sig"].(string)
	if ts, ok := d["ts"].(int64); ok {
		c.TS = ts
	} else if f, ok := d["ts"].(float64); ok {
		c.TS = int64(f)
	}
	if a, ok := d["args"].(map[string]any); ok {
		c.Args = a
	} else {
		c.Args = map[string]any{}
	}
	return c, true
}

func writeResult(ctx context.Context, fs *firestore.Client, deviceID, id string, payload map[string]any, logger *log.Logger) {
	plain, _ := json.Marshal(payload)
	box, err := seal(plain)
	if err != nil {
		logger.Printf("agentapi: seal result failed: %v", err)
		return
	}
	if err := fs.Set(ctx, resultDoc(deviceID), map[string]any{
		"id":  id,
		"box": box,
		"ts":  nowMillis(),
	}); err != nil {
		logger.Printf("agentapi: write result failed: %v", err)
	}
}

// --- dispatch --------------------------------------------------------------
// handle verifies, replay-checks, then dispatches one command. It returns the
// payload to seal back AND whether the command was ACCEPTED (actually ran). A
// rejected command — bad signature, stale, or a replay — returns accepted=false,
// so the caller writes no result and does not advance the replay floor. A command
// that ran but failed operationally (file not found, exec non-zero) is accepted:
// it genuinely executed, and its error belongs in the result.
func handle(ctx context.Context, c command, minTS int64, logger *log.Logger) (map[string]any, bool) {
	if !verifyCommand(c.ID, c.Cmd, c.TS, c.Args, c.Sig) {
		// An unsigned/misigned command is the one thing that must never run: without
		// a valid signature the caller does not hold the Worker's secret.
		logger.Printf("agentapi: refused command %q: bad signature", c.ID)
		return fail("command signature did not verify"), false
	}
	// Two independent replay defences, both resting on ts being INSIDE the signed
	// message — a captured command cannot have its timestamp refreshed without the
	// secret. The command path is world-writable in shape (the Worker has no Google
	// identity to present), so a passerby can re-write a command captured from the
	// world-readable bus, and BOTH checks must hold:
	//   1. Freshness — reject anything outside the time window. Covers the case where
	//      nothing has been handled yet, so there is no floor to compare against.
	//   2. Monotonic floor — reject any command whose ts is not strictly newer than
	//      the newest already run. Worker timestamps only increase, so a captured
	//      OLDER command (the real replay risk) can never clear this. The single-slot
	//      id dedup alone could NOT guarantee this — it remembers one id, not a window.
	if age := nowMillis() - c.TS; age > maxCommandAge || age < -maxCommandAge {
		logger.Printf("agentapi: refused command %q: stale (age %dms)", c.ID, age)
		return fail("command is stale or clock-skewed (possible replay) — resend it"), false
	}
	if c.TS <= minTS {
		logger.Printf("agentapi: refused command %q: ts not newer than last handled (possible replay)", c.ID)
		return fail("command timestamp is not newer than the last one run (possible replay) — resend it"), false
	}
	str := func(k string) string { s, _ := c.Args[k].(string); return s }

	switch c.Cmd {
	case cmdExec:
		r := runExec(ctx, str("shell"), str("line"), str("program"), strSlice(c.Args["args"]), str("cwd"), i64(c.Args["timeoutMs"]))
		logger.Printf("agentapi: exec exit=%d (shell=%q)", r.Exit, str("shell"))
		return map[string]any{"ok": true, "result": r}, true

	case cmdRead:
		data, err := readFile(str("path"))
		if err != nil {
			return fail(err.Error()), true
		}
		return map[string]any{"ok": true, "path": str("path"), "size": int64(len(data)), "dataB64": base64.StdEncoding.EncodeToString(data)}, true

	case cmdWrite:
		raw, err := base64.StdEncoding.DecodeString(str("dataB64"))
		if err != nil {
			return fail("dataB64 is not valid base64: " + err.Error()), true
		}
		if err := writeFile(str("path"), raw); err != nil {
			return fail(err.Error()), true
		}
		return map[string]any{"ok": true, "path": str("path"), "size": int64(len(raw))}, true

	case cmdList:
		entries, err := listDir(str("path"))
		if err != nil {
			return fail(err.Error()), true
		}
		return map[string]any{"ok": true, "path": str("path"), "entries": entries}, true

	case cmdDelete:
		if err := deletePath(str("path")); err != nil {
			return fail(err.Error()), true
		}
		return map[string]any{"ok": true, "path": str("path")}, true

	case cmdInfo:
		return map[string]any{"ok": true, "info": machineInfo()}, true

	default:
		return fail("unknown command: " + c.Cmd), true
	}
}

func fail(msg string) map[string]any { return map[string]any{"ok": false, "error": msg} }

// strSlice coerces a decoded Firestore array (either []string or []any) into
// []string, so exec's `args` survives whichever way it was stored.
func strSlice(v any) []string {
	switch x := v.(type) {
	case []string:
		return x
	case []any:
		out := make([]string, 0, len(x))
		for _, e := range x {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

func i64(v any) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case float64:
		return int64(x)
	default:
		return 0
	}
}
