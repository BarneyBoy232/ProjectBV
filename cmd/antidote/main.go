// Command projectBV-antidote is the one-click uninstaller kept on the USB stick.
// Running it fully removes the agent from this device: it stops and deletes the
// service, removes the Programs & Features entry, and deletes the install and
// data directories.
//
// This is a convenience for whoever manages the fleet — it is NOT the only way
// to remove the agent. The standard Programs & Features uninstall and
// `sc stop/delete projectBV` also work, because the agent never hides itself.
package main

import (
	"os"

	"projectbv/internal/applog"
	"projectbv/internal/config"
	"projectbv/internal/winsvc"
	"projectbv/internal/winutil"
)

func main() {
	logger := applog.New()

	// A machine-wide install (service + Program Files) needs admin to remove; a
	// per-user install doesn't. Only elevate if there's a machine install present.
	machineInstalled := fileExists(config.AgentExePath()) || fileExists(config.LegacyAgentExePath())
	if machineInstalled && !winutil.IsAdmin() {
		if err := winutil.RelaunchElevated(os.Args[1:]); err != nil {
			logger.Printf("antidote: could not elevate: %v", err)
			os.Exit(1)
		}
		return
	}

	// Machine-wide artifacts (ignored if absent or not admin).
	_ = winsvc.Control(logger, "stop")
	_ = winsvc.Control(logger, "uninstall")
	_ = winutil.RemoveUninstallEntry()
	_ = os.RemoveAll(config.InstallDir())
	_ = os.RemoveAll(config.LegacyInstallDir())

	// Per-user artifacts.
	_ = winutil.RemoveRunKey()
	_ = winutil.RemoveUserUninstallEntry()
	_ = os.RemoveAll(config.UserInstallDir())

	_ = os.RemoveAll(config.DataDir())
	logger.Printf("antidote: projectBV removed from this device")
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
