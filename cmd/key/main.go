// Command projectBV-key is the installer ("the key"). Double-clicking it installs
// the agent onto this device; the fleet can also run it on itself to UPDATE the
// agent, with nobody at the machine. It picks the right install automatically:
//
//   - Admin available  -> machine-wide install: a Windows service that runs
//     before login for every user, in C:\ProgramData\projectBV\agent (hidden,
//     locked to admins), listed in Programs & Features.
//   - Standard user    -> per-user install (NO admin, NO UAC): agent in the user's
//     AppData, auto-started at that user's login via the Run key.
//
// If the agent is already installed, this replaces it in place: the running copy
// is stopped, the binary is swapped in one move, started again, and only believed
// once it has stayed up AND checked in with the fleet. Anything short of that puts
// the previous agent back — by copying it into place, or failing that by pointing
// the service straight at the backup — so a device keeps an agent it can be
// reached through.
//
// It runs silently (no window). Progress is written to the agent log.
//
// Flags (used when the fleet updates itself; irrelevant when double-clicked):
//
//	--record-version <v>  record this version as installed, so the agent's own
//	                      update check doesn't install it all over again
//	--no-prompt           never ask for elevation; install per-user instead
//	--detached            internal: set on the copy that does the real work
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"projectbv/internal/applog"
	"projectbv/internal/config"
	"projectbv/internal/updater"
	"projectbv/internal/winsvc"
	"projectbv/internal/winutil"

	"golang.org/x/sys/windows"
)

func main() {
	logger := applog.New()
	args := os.Args[1:]

	// Cut loose from whatever started this, before doing anything else.
	//
	// Updating the agent means stopping the agent — and an agent that runs its
	// installers as ordinary child processes takes them down with it when it goes.
	// (Every agent already in the field does exactly that.) So the first thing this
	// does is start a detached copy of itself and exit cleanly: the parent sees a
	// quick success, and the copy that does the real work outlives it.
	if !hasFlag(args, "--detached") {
		if err := relaunchDetached(args); err != nil {
			logger.Printf("install: could not detach (%v) — continuing in place", err)
		} else {
			return
		}
	}

	version := flagValue(args, "--record-version", config.Version)
	noPrompt := hasFlag(args, "--no-prompt")

	switch {
	case winutil.IsAdmin():
		// Already elevated — do the machine-wide install.
		machineInstall(logger, version)
	case winutil.CanElevate() && !noPrompt:
		// A split-token admin: ask for elevation and do the machine install in the
		// elevated child. If they decline UAC, fall back to a per-user install.
		if err := winutil.RelaunchElevated(args); err == nil {
			return
		}
		logger.Printf("install: elevation declined — installing per-user")
		perUserInstall(logger, version)
	default:
		// A standard user, or a fleet update that must never put a prompt on
		// someone's screen: per-user install, no prompt.
		logger.Printf("install: no admin rights available — installing per-user")
		perUserInstall(logger, version)
	}
}

// relaunchDetached starts this same executable again, with --detached added, in a
// process of its own that no longer dies with its parent.
func relaunchDetached(args []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, append([]string{"--detached"}, args...)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// machineInstall installs the agent as an always-on Windows service (needs admin).
// If a machine install is already there, the binary is replaced in place.
func machineInstall(logger *log.Logger, version string) {
	dst := config.AgentExePath()
	// The folder must be locked down before a binary that runs as SYSTEM is put in
	// it. If that cannot be done, nothing has changed yet: the device keeps the
	// agent it has, wherever it is, and says why.
	if err := winutil.LockInstallDir(); err != nil {
		logger.Printf("install: could not secure %s: %v", config.InstallDir(), err)
		recordUpdateResult(logger, version, "rolled-back", "could not secure the install folder: "+err.Error())
		os.Exit(1)
	}
	// An agent from before 1.3.0 runs from Program Files. convergeServicePath
	// treats that like any other off-path service: it copies the running binary to
	// the new folder and points the service there, then the update carries on as
	// normal. The old folder is only deleted once the new agent has proved itself.
	if err := convergeServicePath(logger, dst); err != nil {
		// The device is running its agent from somewhere unusual and could not be
		// brought back. Going on from here would copy the abandoned binary at the
		// normal path over the only good one on the machine. Stop instead: the
		// device keeps working, and the failure is visible from the dashboard.
		logger.Printf("install: not touching this device until it is back on its normal path: %v", err)
		recordUpdateResult(logger, version, "rolled-back", "the device is running its agent from a recovery copy: "+err.Error())
		os.Exit(1)
	}
	update := fileExists(dst)

	if update {
		if err := updateInPlace(logger, dst, version); err != nil {
			logger.Printf("install: updating the agent failed: %v", err)
			os.Exit(1)
		}
		removeLegacyInstall(logger, dst)
		return
	} else if err := writeAgent(dst); err != nil {
		logger.Printf("install: writing agent failed: %v", err)
		os.Exit(1)
	} else {
		logger.Printf("install: installed agent to %s", dst)
	}

	installedAt := time.Now()
	if err := winsvc.Control(logger, "install"); err != nil {
		// Registering fails harmlessly when the service is already there. Anything
		// else is fatal — and "cannot tell" counts as anything else.
		if _, readErr := winsvc.ImagePath(); readErr != nil {
			logger.Printf("install: service install failed: %v", err)
			os.Exit(1)
		}
		logger.Printf("install: the service is already registered — reusing it")
	}
	// A service left pointing at a backup copy by an earlier failed update has to
	// be pointed back at the real path.
	if err := winsvc.PointAt(dst); err != nil {
		logger.Printf("install: could not point the service at %s: %v", dst, err)
	}
	if err := winutil.WriteUninstallEntry(version); err != nil {
		logger.Printf("install: uninstall entry failed: %v", err)
	}
	// Record the version only once the agent is confirmed up and checking in, so a
	// device that failed to start is never mistaken for one running this build.
	if err := startAndConfirm(logger, dst, installedAt); err != nil {
		logger.Printf("install: the agent did not prove itself: %v (it will try again at next boot)", err)
		recordUpdateResult(logger, version, "rolled-back", "a fresh install did not come up: "+err.Error())
		return
	}
	recordInstalled(logger, version)
	// A fresh install clears any leftover verdict from a past failed update.
	recordUpdateResult(logger, version, "installed", "")
	removeLegacyInstall(logger, dst)
	logger.Printf("install: projectBV %s installed machine-wide and running", version)
}

// removeLegacyInstall deletes the pre-1.3.0 Program Files folder, but only once
// the service is confirmed to be running from the new one — until then that
// folder may hold the only agent this device can be reached through.
func removeLegacyInstall(logger *log.Logger, dst string) {
	legacy := config.LegacyInstallDir()
	if !fileExists(legacy) {
		return
	}
	current, err := winsvc.ImagePath()
	if err != nil || !strings.EqualFold(current, dst) {
		logger.Printf("install: keeping %s — the service is not confirmed on %s yet", legacy, dst)
		return
	}
	if err := os.RemoveAll(legacy); err != nil {
		logger.Printf("install: could not remove the old %s: %v", legacy, err)
		return
	}
	logger.Printf("install: removed the old %s", legacy)
}

// convergeServicePath brings a rescued device back to normal before anything else
// happens to it.
//
// A previous failed update can leave the service pointed at the backup copy —
// running, reachable, but not from the usual path. If an update then started from
// that state it would treat the abandoned binary sitting at the usual path as "the
// agent that works", copy IT over the backup, and destroy the only good copy on
// the machine. So: put the binary the service is actually running back where it
// belongs, and point the service there again.
func convergeServicePath(logger *log.Logger, dst string) error {
	current, err := winsvc.ImagePath()
	switch {
	case errors.Is(err, winsvc.ErrNotInstalled):
		return nil // nothing installed yet: a first install, not a rescue
	case err != nil:
		// Present but unreadable. "Cannot tell" must not be treated as "fine" —
		// carrying on could copy an abandoned binary over the last good one.
		return fmt.Errorf("cannot read which agent this device is running: %w", err)
	case current == "" || strings.EqualFold(current, dst):
		return nil
	}
	logger.Printf("install: this device is running its agent from %s — restoring it to %s first", current, dst)
	if err := winsvc.Control(logger, "stop"); err != nil {
		logger.Printf("install: stopping the service reported %v — continuing", err)
	}
	if err := copyWithRetry(current, dst); err != nil {
		startOrShout(logger, "the agent at its current path")
		return fmt.Errorf("could not restore the agent to %s: %w", dst, err)
	}
	if err := winsvc.PointAt(dst); err != nil {
		startOrShout(logger, "the agent at its current path")
		return fmt.Errorf("could not point the service back at %s: %w", dst, err)
	}
	// The recovery copy is deliberately left on disk. It is still the last binary
	// known to run on this machine, and nothing here has proved its replacement
	// does — the update about to follow makes its own backup from it anyway.
	startOrShout(logger, "the restored agent")
	return nil
}

// updateInPlace replaces the agent binary while the service is running from it.
//
// The order matters, because the worst outcome in this product is a device left
// with no working agent — that means someone has to physically go to it:
//
//  1. stage the new binary beside the old one (nothing is disturbed if this fails),
//  2. keep a copy of the CURRENT binary as .bak — the way back,
//  3. stop the service, swap with one rename, start it,
//  4. confirm it is actually running; if not, put .bak back and start that instead.
//
// Only once the new agent is confirmed running is the version recorded, so a
// rolled-back device asks for the update again rather than believing it took.
func updateInPlace(logger *log.Logger, dst, version string) error {
	staged, err := claimStaging(dst + ".new")
	if err != nil {
		recordUpdateResult(logger, version, "rolled-back", err.Error())
		return err
	}
	// Only ever removes OUR claim: cleared below the moment the rename takes it,
	// so a later installer's claim on the same path is never deleted from here.
	defer func() {
		if staged != "" {
			os.Remove(staged)
		}
	}()
	if err := writeAgent(staged); err != nil {
		recordUpdateResult(logger, version, "rolled-back", "could not stage the new agent: "+err.Error())
		return fmt.Errorf("staging the new agent: %w", err)
	}

	backup := dst + ".bak"
	if err := winutil.CopyFile(dst, backup); err != nil {
		recordUpdateResult(logger, version, "rolled-back", "could not keep a copy of the running agent: "+err.Error())
		return fmt.Errorf("could not keep a copy of the running agent, refusing to replace it: %w", err)
	}

	if err := winsvc.Control(logger, "stop"); err != nil {
		logger.Printf("update: stopping the service reported %v — continuing", err)
	}

	// The service manager reports "stopped" a moment before the process has really
	// let go of its exe, so keep trying the swap for a few seconds.
	if err := renameWithRetry(staged, dst); err != nil {
		logger.Printf("update: could not replace the agent binary: %v — putting the old one back", err)
		startOrShout(logger, "the old agent")
		recordUpdateResult(logger, version, "rolled-back", "could not replace the agent binary")
		return err
	}
	staged = "" // the rename owns the file now
	// Started only now: a rename over a running image cannot succeed, so reaching
	// this line is itself proof the previous agent has let go. Any check-in mark
	// after this instant can only have come from the agent just installed.
	swapAt := time.Now()

	// Two things have to be true before the way back is thrown away: the service
	// stays up, and the new agent actually reaches the fleet. A build that runs but
	// cannot check in is a build nobody can fix from the dashboard — no better than
	// one that will not start.
	if err := startAndConfirm(logger, dst, swapAt); err != nil {
		logger.Printf("update: %s did not prove itself (%v) — rolling back", version, err)
		rollBack(logger, dst, backup, version, err)
		return fmt.Errorf("%s did not prove itself; rolled back", version)
	}

	logger.Printf("install: projectBV updated to %s, running and checking in", version)
	if err := winutil.WriteUninstallEntry(version); err != nil {
		logger.Printf("install: uninstall entry failed: %v", err)
	}
	recordInstalled(logger, version)
	recordUpdateResult(logger, version, "installed", "")
	os.Remove(backup)
	return nil
}

// rollBack puts the previous agent back after a failed update, and does not give
// up while any route remains:
//
//  1. stop the failed agent, then COPY the backup over the live path (a copy, not
//     a move, so the backup still exists if the copy itself fails),
//  2. if that cannot be done, point the service straight at the backup file.
//
// Either way the device ends up running an agent, so it stays fixable from the
// dashboard. Only if both routes fail is the device genuinely stranded, and that
// is recorded as loudly as this code can manage.
func rollBack(logger *log.Logger, dst, backup, version string, cause error) {
	if err := winsvc.Control(logger, "stop"); err != nil {
		logger.Printf("update: stopping the failed agent reported %v — continuing", err)
	}

	if err := copyWithRetry(backup, dst); err == nil {
		// The version is deliberately NOT recorded: this device is still on the old
		// build and should say so.
		recordUpdateResult(logger, version, "rolled-back", cause.Error())
		if err := startAndRunning(logger); err != nil {
			// Restored but not confirmed running — keep the spare copy, this is the
			// moment the device can least afford to have only one.
			logger.Printf("update: the rolled-back agent did not come up: %v — keeping the spare copy", err)
			return
		}
		os.Remove(backup)
		return
	} else {
		logger.Printf("update: could not restore the old agent in place: %v — pointing the service at the backup instead", err)
	}

	if err := winsvc.PointAt(backup); err == nil {
		startOrShout(logger, "the agent running from its backup copy")
		recordUpdateResult(logger, version, "rolled-back", "running from the backup copy: "+cause.Error())
		return
	} else {
		logger.Printf("update: could not point the service at the backup: %v", err)
	}

	logger.Printf("update: ROLLBACK FAILED, this device has no working agent")
	recordUpdateResult(logger, version, "rollback-failed", cause.Error())
}

// claimStaging makes sure only one installer is using the staging path. Two
// installers writing the same .new file could rename a half-written binary over
// the live agent. A leftover file from a crashed run is cleared after 10 minutes.
func claimStaging(path string) (string, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0755)
	if err == nil {
		f.Close()
		return path, nil
	}
	info, statErr := os.Stat(path)
	if statErr == nil && time.Since(info.ModTime()) > 10*time.Minute {
		if rmErr := os.Remove(path); rmErr == nil {
			return claimStaging(path)
		}
	}
	return "", fmt.Errorf("another installer is already updating this agent")
}

func renameWithRetry(from, to string) error {
	var err error
	for i := 0; i < 20; i++ {
		if err = os.Rename(from, to); err == nil {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return err
}

// startAndConfirm starts the service and only reports success if the new agent
// both stays running and checks in with the fleet.
//
// A start command returning cleanly proves nothing — a bad build can exit
// immediately and be restarted by Windows over and over, looking alive at any
// single instant. And an agent that runs happily but cannot reach Firebase is
// just as bad: it can never be told to do anything again.
func startAndConfirm(logger *log.Logger, agentExe string, since time.Time) error {
	if err := winsvc.Control(logger, "start"); err != nil {
		return err
	}
	time.Sleep(5 * time.Second)
	if err := winsvc.StaysRunning(60 * time.Second); err != nil {
		return err
	}
	return waitForCheckIn(agentExe, since, 3*time.Minute)
}

// waitForCheckIn waits for the agent installed at agentExe to record that it has
// reached the fleet, since the given moment.
//
// Both halves matter. The mark sits beside that binary and names the executable
// that wrote it, so a different agent on the same device cannot vouch for this
// one. And it must be newer than the swap, so a mark left by the agent that was
// replaced doesn't count as the new one checking in.
func waitForCheckIn(agentExe string, since time.Time, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	path := updater.FleetReachedPath(agentExe)
	for {
		if info, err := os.Stat(path); err == nil && info.ModTime().After(since) {
			if r, err := updater.ReadFleetReach(agentExe); err == nil && strings.EqualFold(r.Exe, agentExe) {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the new agent did not check in with the fleet within %v", wait)
		}
		time.Sleep(5 * time.Second)
	}
}

// copyWithRetry copies from over to, retrying while the destination is still
// locked by a process that is on its way out.
func copyWithRetry(from, to string) error {
	var err error
	for i := 0; i < 20; i++ {
		if err = winutil.CopyFile(from, to); err == nil {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return err
}

// startAndRunning starts the service and reports whether it is actually running.
func startAndRunning(logger *log.Logger) error {
	if err := winsvc.Control(logger, "start"); err != nil {
		return err
	}
	time.Sleep(3 * time.Second)
	return winsvc.Running()
}

// startOrShout starts the service and makes a failure very loud in the log: at
// that point the device is offline until someone reboots it or visits it.
func startOrShout(logger *log.Logger, what string) {
	if err := winsvc.Control(logger, "start"); err != nil {
		logger.Printf("update: %s DID NOT RESTART: %v", what, err)
	}
}

// perUserInstall installs the agent for the current user only (no admin): copies
// it into AppData, auto-starts it at login via the Run key, and launches it now.
//
// Replacing an agent that is already there gets the same protection as the
// machine-wide path: keep a copy of what is running, put the new one in, and only
// believe it once it has actually checked in with the fleet — otherwise put the
// old one back. A device without admin rights is exactly the device nobody can
// conveniently walk over to.
func perUserInstall(logger *log.Logger, version string) {
	dst := config.UserAgentExePath()
	update := fileExists(dst)
	backup := dst + ".bak"

	if update {
		if err := winutil.CopyFile(dst, backup); err != nil {
			logger.Printf("install: could not keep a copy of the running agent, refusing to replace it: %v", err)
			os.Exit(1)
		}
		stopUserAgent(logger)
	}
	if err := writeAgentWithRetry(dst); err != nil {
		logger.Printf("install: writing agent failed: %v", err)
		if update {
			restoreUserAgent(logger, dst, backup, version, err)
		}
		os.Exit(1)
	}
	// A self-healing logon task, not a bare Run key: it restarts the agent within
	// minutes if it is ever closed or crashes, so a machine that is on and in use
	// can't sit there offline. The old Run key (from a 1.0.0 install) is removed so
	// the two never both launch the agent.
	_ = winutil.RemoveRunKey()
	if err := winutil.InstallLogonTask(dst); err != nil {
		logger.Printf("install: could not set up autostart: %v", err)
		if update {
			restoreUserAgent(logger, dst, backup, version, err)
		}
		os.Exit(1)
	}
	if err := winutil.WriteUserUninstallEntry(version); err != nil {
		logger.Printf("install: user uninstall entry failed: %v", err)
	}

	// Start it now so the user doesn't have to sign out and back in first.
	startedAt := time.Now()
	if err := winutil.StartLogonTask(); err != nil {
		// Fall back to launching it directly; the task still keeps it alive after.
		logger.Printf("install: starting via the task failed (%v) — launching directly", err)
		if err := exec.Command(dst).Start(); err != nil {
			logger.Printf("install: could not start agent now: %v", err)
			if update {
				restoreUserAgent(logger, dst, backup, version, err)
				os.Exit(1)
			}
			return // first install: it starts at next login
		}
	}

	if !update {
		recordInstalled(logger, version)
		recordUpdateResult(logger, version, "installed", "")
		logger.Printf("install: projectBV %s installed per-user and running", version)
		return
	}

	if err := waitForCheckIn(dst, startedAt, 3*time.Minute); err != nil {
		logger.Printf("update: %s did not check in (%v) — rolling back", version, err)
		restoreUserAgent(logger, dst, backup, version, err)
		return
	}
	recordInstalled(logger, version)
	recordUpdateResult(logger, version, "installed", "")
	os.Remove(backup)
	logger.Printf("install: projectBV %s updated per-user, running and checking in", version)
}

// restoreUserAgent puts back the per-user agent that was working, and starts it.
// The version is deliberately not recorded, so this device keeps reporting the
// build it is actually running.
func restoreUserAgent(logger *log.Logger, dst, backup, version string, cause error) {
	stopUserAgent(logger)
	if err := copyWithRetry(backup, dst); err != nil {
		logger.Printf("update: ROLLBACK FAILED, this device has no working agent: %v", err)
		recordUpdateResult(logger, version, "rollback-failed", cause.Error())
		return
	}
	if err := exec.Command(dst).Start(); err != nil {
		logger.Printf("update: the rolled-back agent did not start: %v", err)
	}
	recordUpdateResult(logger, version, "rolled-back", cause.Error())
	os.Remove(backup)
	logger.Printf("update: rolled back to the previous per-user agent")
}

// stopUserAgent ends this user's running agent so its binary can be overwritten.
// Only this user's own processes can be ended here — a machine-wide service
// running as SYSTEM is untouched, which is correct: that one is handled by
// replaceRunningAgent instead.
func stopUserAgent(logger *log.Logger) {
	cmd := exec.Command("taskkill", "/F", "/IM", filepath.Base(config.UserAgentExePath()))
	if out, err := cmd.CombinedOutput(); err != nil {
		logger.Printf("update: no running per-user agent to stop (%s)", firstLine(out))
	}
}

// recordInstalled writes the installed version into the agent's own state file.
//
// The agent tracks what it has installed in DataDir/state.json. When it updates
// ITSELF it gets stopped part-way through and can never record the result — so
// without this, every check-in would download and reinstall the same agent
// forever. The version comes from the manifest entry (via --record-version) so it
// matches exactly what the fleet asked for.
func recordInstalled(logger *log.Logger, version string) {
	dir := config.DataDir()
	path := filepath.Join(dir, "state.json")

	st := map[string]string{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	st[config.ServiceName] = version

	if err := os.MkdirAll(dir, 0755); err != nil {
		logger.Printf("install: cannot create %s: %v", dir, err)
		return
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return
	}
	if err := os.WriteFile(path, b, 0644); err != nil {
		logger.Printf("install: cannot record the installed version: %v", err)
	}
}

// recordUpdateResult leaves a note saying how the last agent update actually went.
// The agent reads it and puts it in its heartbeat, so the console can tell apart
// three states that otherwise look identical from a distance: not checked in yet,
// updated and rolled back, and rollback failed. Without it, "push to one device
// first" is a safety net nobody can read.
func recordUpdateResult(logger *log.Logger, version, result, detail string) {
	dir := config.DataDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return
	}
	b, err := json.MarshalIndent(map[string]string{
		"version": version,
		"result":  result,
		"detail":  detail,
		"at":      time.Now().UTC().Format(time.RFC3339),
	}, "", "  ")
	if err != nil {
		return
	}
	if err := os.WriteFile(filepath.Join(dir, "last-update.json"), b, 0644); err != nil {
		logger.Printf("install: cannot record the update result: %v", err)
	}
}

// writeAgent writes the installed agent binary to dst. It prefers the embedded
// payload (single-file key); if that's just the build placeholder, it copies a
// sibling projectBV.exe from the USB instead.
func writeAgent(dst string) error {
	const minRealSize = 1 << 20 // 1 MB; the real agent is ~20 MB, placeholder is bytes
	if len(agentBinary) >= minRealSize {
		if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
			return err
		}
		return os.WriteFile(dst, agentBinary, 0755)
	}
	// Fallback: sibling on the USB.
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	sibling := filepath.Join(filepath.Dir(exe), "projectBV.exe")
	if _, err := os.Stat(sibling); err != nil {
		return fmt.Errorf("no embedded agent and no sibling projectBV.exe found: %w", err)
	}
	return winutil.CopyFile(sibling, dst)
}

// writeAgentWithRetry keeps trying for a few seconds: a just-ended agent can hold
// its own exe open briefly after the process is gone.
func writeAgentWithRetry(dst string) error {
	var err error
	for i := 0; i < 20; i++ {
		if err = writeAgent(dst); err == nil {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return err
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func firstLine(b []byte) string {
	for i, c := range b {
		if c == '\r' || c == '\n' {
			return string(b[:i])
		}
	}
	return string(b)
}

// flagValue returns the value following name, or def if it isn't there.
func flagValue(args []string, name, def string) string {
	for i, a := range args {
		if a != name || i+1 >= len(args) {
			continue
		}
		// Guard against a dangling flag: "--record-version --no-prompt" must not
		// record the literal string "--no-prompt" as the installed version.
		if v := args[i+1]; !strings.HasPrefix(v, "--") {
			return v
		}
	}
	return def
}

func hasFlag(args []string, name string) bool {
	for _, a := range args {
		if a == name {
			return true
		}
	}
	return false
}
