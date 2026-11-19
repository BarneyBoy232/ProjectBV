// Package winutil holds the small Windows-specific helpers the installer and
// uninstaller need: checking/elevating to admin, copying files, and writing the
// Programs & Features (Add/Remove Programs) entry.
//
// The uninstall entry is a deliberate DISCOVERABILITY feature. The agent shows
// up in Settings > Apps and in the classic Programs & Features list under
// "projectBV", so the machine's owner can always see it is installed and remove
// it the normal way. There is no attempt to hide from these lists.
package winutil

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"projectbv/internal/config"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const uninstallKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\projectBV`

// IsAdmin reports whether the current process is running elevated.
func IsAdmin() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

// CanElevate reports whether the current (non-elevated) user is an administrator
// who could approve a UAC prompt. It reads the token's elevation type: "Limited"
// means a split-token admin (can elevate); "Default" means a standard user who
// cannot. This lets the installer skip a pointless UAC prompt for standard users.
func CanElevate() bool {
	const tokenElevationTypeLimited = 3 // TokenElevationTypeLimited
	token := windows.GetCurrentProcessToken()
	var etype uint32
	var n uint32
	err := windows.GetTokenInformation(token, windows.TokenElevationType,
		(*byte)(unsafe.Pointer(&etype)), uint32(unsafe.Sizeof(etype)), &n)
	if err != nil {
		return false
	}
	return etype == tokenElevationTypeLimited
}

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`
const userUninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\projectBV`

// SetRunKey registers the agent to auto-start at the current user's login
// (per-user install — no admin needed).
func SetRunKey(exePath string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue("projectBV", exePath)
}

// RemoveRunKey removes the per-user auto-start entry.
func RemoveRunKey() error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return nil // key/value absent is fine
	}
	defer k.Close()
	_ = k.DeleteValue("projectBV")
	return nil
}

// WriteUserUninstallEntry registers projectBV in the per-user Programs & Features.
func WriteUserUninstallEntry(version string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, userUninstallKey, registry.WRITE)
	if err != nil {
		return err
	}
	defer k.Close()
	agent := config.UserAgentExePath()
	_ = k.SetStringValue("DisplayName", "projectBV (per-user)")
	_ = k.SetStringValue("DisplayVersion", version)
	_ = k.SetStringValue("Publisher", "projectBV")
	_ = k.SetStringValue("InstallLocation", config.UserInstallDir())
	_ = k.SetStringValue("DisplayIcon", agent)
	_ = k.SetStringValue("UninstallString", fmt.Sprintf(`"%s" --uninstall`, agent))
	_ = k.SetDWordValue("NoModify", 1)
	_ = k.SetDWordValue("NoRepair", 1)
	return nil
}

// RemoveUserUninstallEntry deletes the per-user Programs & Features registration.
func RemoveUserUninstallEntry() error {
	err := registry.DeleteKey(registry.CURRENT_USER, userUninstallKey)
	if err == registry.ErrNotExist {
		return nil
	}
	return err
}

// RelaunchElevated re-runs this same executable with the given arguments via a
// UAC prompt ("runas"). The current (non-elevated) process should exit after
// calling this.
func RelaunchElevated(args []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, _ := syscall.UTF16PtrFromString("runas")
	file, _ := syscall.UTF16PtrFromString(exe)
	params, _ := syscall.UTF16PtrFromString(strings.Join(args, " "))

	shell32 := windows.NewLazySystemDLL("shell32.dll")
	shellExecute := shell32.NewProc("ShellExecuteW")
	// ShellExecuteW(hwnd, verb, file, params, dir, showCmd). SW_SHOWNORMAL = 1.
	r, _, callErr := shellExecute.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(file)),
		uintptr(unsafe.Pointer(params)),
		0,
		1,
	)
	if r <= 32 { // ShellExecute returns >32 on success
		return fmt.Errorf("elevation failed (code %d): %v", r, callErr)
	}
	return nil
}

// CopyFile copies src to dst, creating parent directories as needed.
func CopyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	// Copying a file onto itself would truncate it to nothing and report success.
	// Callers here copy agent binaries around during an update, so that would
	// destroy the very thing being protected.
	if a, err := os.Stat(src); err == nil {
		if b, err := os.Stat(dst); err == nil && os.SameFile(a, b) {
			return nil
		}
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// LockInstallDir creates the machine-wide install folder and gives it its own
// ACL: SYSTEM and Administrators full control, Users read/execute only, nothing
// inherited from ProgramData (which lets every user create files). Without this a
// standard user could drop or swap a binary the service runs as SYSTEM.
func LockInstallDir() error {
	dir := config.InstallDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil)
}

// WriteUninstallEntry registers projectBV in Programs & Features.
func WriteUninstallEntry(version string) error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, uninstallKey, registry.WRITE)
	if err != nil {
		return err
	}
	defer k.Close()

	agent := config.AgentExePath()
	set := func(name, val string) error { return k.SetStringValue(name, val) }
	if err := set("DisplayName", "projectBV"); err != nil {
		return err
	}
	_ = set("DisplayVersion", version)
	_ = set("Publisher", "projectBV")
	_ = set("InstallLocation", config.InstallDir())
	_ = set("DisplayIcon", agent)
	// Running the installed agent with --uninstall performs a full removal.
	_ = set("UninstallString", fmt.Sprintf(`"%s" --uninstall`, agent))
	_ = k.SetDWordValue("NoModify", 1)
	_ = k.SetDWordValue("NoRepair", 1)
	return nil
}

// RemoveUninstallEntry deletes the Programs & Features registration.
func RemoveUninstallEntry() error {
	err := registry.DeleteKey(registry.LOCAL_MACHINE, uninstallKey)
	if err == registry.ErrNotExist {
		return nil
	}
	return err
}
