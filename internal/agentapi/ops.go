package agentapi

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"unsafe"

	"projectbv/internal/config"

	"golang.org/x/sys/windows"
)

// maxInline is the biggest file `read`/`write` will move inline. Bigger payloads
// are what `exec` (robocopy, Compress-Archive, curl) is for — this keeps a single
// sealed result comfortably under Firestore's ~1MB document ceiling.
const maxInline = 512 * 1024

type fsEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
	Mtime int64  `json:"mtime"`
}

// listDir lists one directory. The empty path lists the machine's drive letters,
// so the AI can start where a file explorer does.
func listDir(path string) ([]fsEntry, error) {
	if path == "" {
		return drives(), nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	infos, err := f.Readdir(-1)
	if err != nil && len(infos) == 0 {
		return nil, err
	}
	out := make([]fsEntry, 0, len(infos))
	for _, fi := range infos {
		out = append(out, fsEntry{Name: fi.Name(), IsDir: fi.IsDir(), Size: fi.Size(), Mtime: fi.ModTime().UnixMilli()})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

func drives() []fsEntry {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}
	out := []fsEntry{}
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		out = append(out, fsEntry{Name: string(rune('A'+i)) + ":\\", IsDir: true})
	}
	return out
}

func readFile(path string) ([]byte, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if fi.IsDir() {
		return nil, fmt.Errorf("%s is a folder, not a file", path)
	}
	if fi.Size() > maxInline {
		return nil, fmt.Errorf("file is %s; inline read is capped at %s — use exec (e.g. Compress-Archive) for large files",
			humanSize(fi.Size()), humanSize(maxInline))
	}
	return os.ReadFile(path)
}

func writeFile(path string, data []byte) error {
	if underInstallDir(path) {
		return fmt.Errorf("refused: that path is inside the projectBV agent's own folder")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// deletePath sends a path to the Recycle Bin (recoverable). An AI deleting the
// wrong thing on a machine nobody can visit is exactly the mistake that should be
// undoable, so this never hard-deletes.
func deletePath(path string) error {
	if underInstallDir(path) {
		return fmt.Errorf("refused: that path is inside the projectBV agent's own folder")
	}
	return recycle(path)
}

func machineInfo() map[string]any {
	host, _ := os.Hostname()
	return map[string]any{
		"hostname":    host,
		"os":          runtime.GOOS,
		"arch":        runtime.GOARCH,
		"agent":       config.Version,
		"runningAs":   "SYSTEM (LocalSystem service)",
		"admin":       true,
		"programData": config.DataDir(),
	}
}

// underInstallDir refuses any write/delete whose target sits inside the agent's own
// program or state folders, so the Agent API can never delete or overwrite the
// service that carries it and brick a device no one can visit to repair. Matches
// internal/files/ops.go's guard (both install locations + the data dir).
func underInstallDir(path string) bool {
	target, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	target = strings.ToLower(filepath.Clean(target))
	for _, dir := range []string{config.InstallDir(), config.UserInstallDir(), config.DataDir()} {
		base, err := filepath.Abs(dir)
		if err != nil {
			continue
		}
		base = strings.ToLower(filepath.Clean(base))
		if target == base || strings.HasPrefix(target, base+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// recycle sends a path to the Recycle Bin via SHFileOperationW with FOF_ALLOWUNDO,
// so a mistaken remote delete is recoverable.
func recycle(path string) error {
	from, err := syscall.UTF16FromString(path)
	if err != nil {
		return err
	}
	from = append(from, 0) // pFrom must be double-null terminated

	const (
		foDelete          = 0x0003
		fofSilent         = 0x0004
		fofNoConfirmation = 0x0010
		fofAllowUndo      = 0x0040
		fofNoErrorUI      = 0x0400
		fofNoConfirmMkdir = 0x0200
	)
	op := shFileOpStruct{
		wFunc:  foDelete,
		pFrom:  &from[0],
		fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI | fofNoConfirmMkdir,
	}
	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 {
		return fmt.Errorf("delete failed (code %d)", r)
	}
	if op.fAnyOperationsAborted != 0 {
		return fmt.Errorf("delete aborted")
	}
	return nil
}

type shFileOpStruct struct {
	hwnd                  uintptr
	wFunc                 uint32
	pFrom                 *uint16
	pTo                   *uint16
	fFlags                uint16
	fAnyOperationsAborted int32
	hNameMappings         uintptr
	lpszProgressTitle     *uint16
}

var (
	shell32              = windows.NewLazySystemDLL("shell32.dll")
	procSHFileOperationW = shell32.NewProc("SHFileOperationW")
)

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
