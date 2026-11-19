// Command projectBV is the installed deploy agent. With no arguments it runs
// under the Windows service manager (the normal mode). It also understands a
// couple of maintenance flags used by the installer/uninstaller.
//
//	projectBV.exe                 run as the service (default)
//	projectBV.exe --service <op>  install|start|stop|uninstall the service
//	projectBV.exe --uninstall     full removal (used by Programs & Features)
package main

import (
	"log"
	"os"

	"projectbv/internal/applog"
	"projectbv/internal/config"
	"projectbv/internal/winsvc"
	"projectbv/internal/winutil"
)

func main() {
	logger := applog.New()
	args := os.Args[1:]

	if len(args) > 0 {
		switch args[0] {
		case "--service":
			if len(args) < 2 {
				logger.Printf("agent: --service needs an action")
				os.Exit(2)
			}
			if err := winsvc.Control(logger, args[1]); err != nil {
				logger.Printf("agent: service %s failed: %v", args[1], err)
				os.Exit(1)
			}
			return
		case "--uninstall":
			fullUninstall(logger)
			return
		}
	}

	// Default: run under the service manager.
	if err := winsvc.RunService(logger); err != nil {
		logger.Printf("agent: service run error: %v", err)
		os.Exit(1)
	}
}

// fullUninstall removes projectBV whether it was installed machine-wide (service)
// or per-user (Run key). A machine install needs admin to remove the service +
// Program Files, so it self-elevates only in that case; a per-user install
// removes cleanly with no admin.
func fullUninstall(logger *log.Logger) {
	machineInstalled := fileExists(config.AgentExePath()) || fileExists(config.LegacyAgentExePath())
	if machineInstalled && !winutil.IsAdmin() {
		if err := winutil.RelaunchElevated([]string{"--uninstall"}); err != nil {
			logger.Printf("uninstall: could not elevate: %v", err)
			os.Exit(1)
		}
		return
	}

	// Machine-wide artifacts (no-ops / ignored if not present or not admin).
	_ = winsvc.Control(logger, "stop")
	_ = winsvc.Control(logger, "uninstall")
	_ = winutil.RemoveUninstallEntry()
	_ = os.RemoveAll(config.InstallDir())
	_ = os.RemoveAll(config.LegacyInstallDir())

	// Per-user artifacts.
	_ = winutil.RemoveRunKey()
	_ = winutil.RemoveLogonTask()
	_ = winutil.RemoveUserUninstallEntry()
	_ = os.RemoveAll(config.UserInstallDir())

	_ = os.RemoveAll(config.DataDir())
	logger.Printf("uninstall: complete")
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
