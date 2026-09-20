package files

import (
	"context"
	"encoding/json"
	"fmt"
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
	maxListing    = 5000            // keep a sealed result under Firestore's 1MB cap
	searchLimit   = 2000
	searchBudget  = 60 * time.Second
	// One-shot transfer ceiling, matching the Storage rules' per-blob cap. A file
	// over this fails with a clear message rather than an opaque relay error;
	// chunked/resumable transfer for larger files is future work.
	maxTransferBytes = 200 * 1024 * 1024
)

// Run is the Files device loop: it announces presence, honours the on/off switch,
// and services one signed command at a time. It blocks until ctx is cancelled and
// never returns an error — like the rest of the agent, a failure is logged and the
// loop keeps going.
func Run(ctx context.Context, fs *firestore.Client, hc *http.Client, deviceID, host string, logger *log.Logger) {
	logger.Printf("files: started for device %q", deviceID)

	enabled := readEnabled(ctx, fs, deviceID)
	writePresence(ctx, fs, deviceID, host, enabled)

	// Skip whatever command is already sitting there from a previous session, so a
	// restart never re-runs a stale action the operator has long since moved past.
	lastHandled := currentCommandID(ctx, fs, deviceID)

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
			lastHandled = cmd.ID
			out := handle(ctx, hc, cmd, logger)
			writeResult(ctx, fs, deviceID, cmd.ID, out, logger)
		}
	}
}

// --- presence + switch ----------------------------------------------------
func writePresence(ctx context.Context, fs *firestore.Client, deviceID, host string, enabled bool) {
	_ = fs.Set(ctx, agentDoc(deviceID), map[string]any{
		"online":   true,
		"host":     host,
		"version":  config.Version,
		"enabled":  enabled,
		"lastSeen": time.Now().UnixMilli(),
	})
}

func readEnabled(ctx context.Context, fs *firestore.Client, deviceID string) bool {
	d, err := fs.Get(ctx, enabledDoc(deviceID))
	if err != nil || d == nil {
		return false
	}
	on, _ := d["enabled"].(bool)
	return on
}

// --- the command --------------------------------------------------------
type command struct {
	ID   string
	Cmd  string
	TS   int64
	Args map[string]any
	Sig  string
}

func currentCommandID(ctx context.Context, fs *firestore.Client, deviceID string) string {
	if c, ok := readCommand(ctx, fs, deviceID); ok {
		return c.ID
	}
	return ""
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
		logger.Printf("files: seal result failed: %v", err)
		return
	}
	if err := fs.Set(ctx, resultDoc(deviceID), map[string]any{
		"id":  id,
		"box": box,
		"ts":  time.Now().UnixMilli(),
	}); err != nil {
		logger.Printf("files: write result failed: %v", err)
	}
}

// --- dispatch -----------------------------------------------------------
func handle(ctx context.Context, hc *http.Client, c command, logger *log.Logger) map[string]any {
	if !verifyCommand(c.ID, c.Cmd, c.TS, c.Args, c.Sig) {
		return fail("command signature did not verify")
	}
	str := func(k string) string { s, _ := c.Args[k].(string); return s }

	switch c.Cmd {
	case cmdList:
		path, entries, err := listDir(str("path"))
		if err != nil {
			return fail(err.Error())
		}
		truncated := false
		if len(entries) > maxListing {
			entries = entries[:maxListing]
			truncated = true
		}
		return map[string]any{"ok": true, "path": path, "entries": entries, "truncated": truncated}

	case cmdStat:
		e, err := statOne(str("path"))
		if err != nil {
			return fail(err.Error())
		}
		return map[string]any{"ok": true, "entry": e}

	case cmdSearch:
		root := str("root")
		if root == "" {
			return fail("search needs a root folder")
		}
		entries := searchTree(root, str("query"), searchLimit, time.Now().Add(searchBudget))
		return map[string]any{"ok": true, "path": root, "entries": entries}

	case cmdPull:
		return doPull(ctx, hc, c, str("path"), logger)

	case cmdPush:
		return doPush(ctx, hc, c, str("storagePath"), str("dest"), logger)

	case cmdMkdir:
		return guardWrite(str("path"), func() error { return makeDir(str("path")) })

	case cmdRename:
		return guardWrite2(str("from"), str("to"), func() error { return renamePath(str("from"), str("to")) })

	case cmdMove:
		return guardWrite2(str("from"), str("to"), func() error { return movePath(str("from"), str("to")) })

	case cmdCopy:
		// Copy only writes to `to`; the source is read, so guard the destination.
		return guardWrite(str("to"), func() error { return copyPath(str("from"), str("to")) })

	case cmdDelete:
		return guardWrite(str("path"), func() error { return recycle(str("path")) })

	default:
		return fail("unknown command: " + c.Cmd)
	}
}

func doPull(ctx context.Context, hc *http.Client, c command, path string, logger *log.Logger) map[string]any {
	// Pre-check the size so an oversized file fails with a clear message instead of
	// an opaque relay error, and so we never try to hold a huge file in RAM. (Real
	// chunked/resumable transfer for very large files is still to come.)
	if fi, err := statOne(path); err == nil && fi.Size > maxTransferBytes {
		return fail("file is too large to transfer in one piece (" +
			humanSize(fi.Size) + "; limit " + humanSize(maxTransferBytes) + ")")
	}
	data, err := readFile(path)
	if err != nil {
		return fail(err.Error())
	}
	sealed, err := sealBytes(data)
	if err != nil {
		return fail(err.Error())
	}
	obj := storageOut(c.ID)
	if err := uploadObject(ctx, hc, obj, sealed); err != nil {
		return fail("relay upload failed: " + err.Error())
	}
	return map[string]any{"ok": true, "storagePath": obj, "name": baseName(path), "size": int64(len(data))}
}

func doPush(ctx context.Context, hc *http.Client, c command, storagePath, dest string, logger *log.Logger) map[string]any {
	if dest == "" {
		return fail("push needs a destination")
	}
	if underInstallDir(dest) {
		return fail("refused: that path is inside the projectBV agent's own folder")
	}
	sealed, err := downloadObject(ctx, hc, storagePath)
	if err != nil {
		return fail("relay download failed: " + err.Error())
	}
	data, err := openBytes(sealed)
	if err != nil {
		return fail("could not open the uploaded blob: " + err.Error())
	}
	if err := writeFile(dest, data); err != nil {
		return fail(err.Error())
	}
	// Consume the relay blob now that it has landed.
	_ = deleteObject(ctx, hc, storagePath)
	return map[string]any{"ok": true, "dest": dest, "size": int64(len(data))}
}

// guardWrite refuses a write that targets the agent's own install dir, then runs fn.
func guardWrite(target string, fn func() error) map[string]any {
	if underInstallDir(target) {
		return fail("refused: that path is inside the projectBV agent's own folder")
	}
	if err := fn(); err != nil {
		return fail(err.Error())
	}
	return map[string]any{"ok": true}
}

func guardWrite2(a, b string, fn func() error) map[string]any {
	if underInstallDir(a) || underInstallDir(b) {
		return fail("refused: that path is inside the projectBV agent's own folder")
	}
	if err := fn(); err != nil {
		return fail(err.Error())
	}
	return map[string]any{"ok": true}
}

func fail(msg string) map[string]any { return map[string]any{"ok": false, "error": msg} }

func baseName(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '\\' || p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}

func humanSize(n int64) string {
	const u = "BKMGT"
	f := float64(n)
	i := 0
	for f >= 1024 && i < len(u)-1 {
		f /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d B", n)
	}
	return fmt.Sprintf("%.1f %cB", f, u[i])
}

