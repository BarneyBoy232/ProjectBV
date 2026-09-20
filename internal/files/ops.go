package files

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"projectbv/internal/config"

	"golang.org/x/sys/windows"
)

// entry is one row in a directory listing, matching the fields the dashboard's
// listing table reads.
type entry struct {
	Name  string   `json:"name"`
	IsDir bool     `json:"isDir"`
	Size  int64    `json:"size"`
	Mtime int64    `json:"mtime"` // epoch ms
	Attrs []string `json:"attrs,omitempty"`
	// Drive rows carry capacity so the operator can triage a dying/full disk
	// before pulling anything. Zero on ordinary files/folders.
	Total int64 `json:"total,omitempty"`
	Free  int64 `json:"free,omitempty"`
}

// listDir lists one directory. The empty path is the synthetic "This PC" root and
// lists the machine's drives, so the operator starts where a file explorer does.
func listDir(path string) (string, []entry, error) {
	if path == "" {
		return "", drives(), nil
	}
	f, err := os.Open(path)
	if err != nil {
		return path, nil, err
	}
	defer f.Close()
	infos, err := f.Readdir(-1)
	if err != nil && len(infos) == 0 {
		return path, nil, err
	}
	out := make([]entry, 0, len(infos))
	for _, fi := range infos {
		out = append(out, entry{
			Name:  fi.Name(),
			IsDir: fi.IsDir(),
			Size:  fi.Size(),
			Mtime: fi.ModTime().UnixMilli(),
			Attrs: attrsOf(fi),
		})
	}
	return path, out, nil
}

// drives enumerates fixed and removable volumes via the classic bitmask.
func drives() []entry {
	mask, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}
	out := []entry{}
	for i := 0; i < 26; i++ {
		if mask&(1<<uint(i)) == 0 {
			continue
		}
		letter := string(rune('A'+i)) + ":\\"
		e := entry{Name: letter, IsDir: true}
		if total, free, ok := diskSpace(letter); ok {
			e.Total, e.Free = total, free
		}
		out = append(out, e)
	}
	return out
}

// diskSpace returns a volume's total and free bytes, so the drive list can show
// how full each disk is. A drive that can't be queried (no media in a card
// reader, say) just reports nothing rather than failing the whole listing.
func diskSpace(root string) (total, free int64, ok bool) {
	p, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return 0, 0, false
	}
	var freeAvail, totalBytes, totalFree uint64
	r, _, _ := procGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&freeAvail)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return 0, 0, false
	}
	return int64(totalBytes), int64(freeAvail), true
}

func attrsOf(fi os.FileInfo) []string {
	var a []string
	if sys, ok := fi.Sys().(*syscall.Win32FileAttributeData); ok {
		f := sys.FileAttributes
		if f&syscall.FILE_ATTRIBUTE_HIDDEN != 0 {
			a = append(a, "hidden")
		}
		if f&syscall.FILE_ATTRIBUTE_SYSTEM != 0 {
			a = append(a, "system")
		}
	}
	return a
}

func statOne(path string) (entry, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return entry{}, err
	}
	return entry{Name: fi.Name(), IsDir: fi.IsDir(), Size: fi.Size(), Mtime: fi.ModTime().UnixMilli(), Attrs: attrsOf(fi)}, nil
}

func readFile(path string) ([]byte, error) {
	if fi, err := os.Stat(path); err == nil && fi.IsDir() {
		return nil, fmt.Errorf("%s is a folder, not a file", path)
	}
	return os.ReadFile(path)
}

func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func makeDir(path string) error { return os.MkdirAll(path, 0o755) }

func renamePath(from, to string) error { return os.Rename(from, to) }

// movePath renames when it can and falls back to copy+delete across volumes,
// which os.Rename cannot do (a common case: moving off a dying drive).
func movePath(from, to string) error {
	if err := os.Rename(from, to); err == nil {
		return nil
	}
	if err := copyPath(from, to); err != nil {
		return err
	}
	return os.RemoveAll(from)
}

// copyPath copies a file or a whole directory tree.
func copyPath(from, to string) error {
	fi, err := os.Stat(from)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return copyFile(from, to, fi)
	}
	return filepath.Walk(from, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(from, p)
		dst := filepath.Join(to, rel)
		if info.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		return copyFile(p, dst, info)
	})
}

func copyFile(from, to string, fi os.FileInfo) error {
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return err
	}
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return os.Chtimes(to, time.Now(), fi.ModTime())
}

// recycle sends a path to the Recycle Bin via SHFileOperationW with FOF_ALLOWUNDO,
// so a mistaken remote delete is recoverable — the choice the operator made.
func recycle(path string) error {
	// pFrom must be double-null terminated.
	from, err := syscall.UTF16FromString(path)
	if err != nil {
		return err
	}
	from = append(from, 0) // extra NUL for the list terminator

	const (
		foDelete            = 0x0003
		fofSilent           = 0x0004
		fofNoConfirmation   = 0x0010
		fofAllowUndo        = 0x0040
		fofNoErrorUI        = 0x0400
		fofNoConfirmMkdir   = 0x0200
		fofWantNukeWarning  = 0x4000
	)

	op := shFileOpStruct{
		wFunc:  foDelete,
		pFrom:  &from[0],
		fFlags: fofAllowUndo | fofNoConfirmation | fofSilent | fofNoErrorUI | fofNoConfirmMkdir,
	}
	r, _, _ := procSHFileOperationW.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 {
		return fmt.Errorf("recycle failed (code %d)", r)
	}
	if op.fAnyOperationsAborted != 0 {
		return fmt.Errorf("recycle aborted")
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

	kernel32                = windows.NewLazySystemDLL("kernel32.dll")
	procGetDiskFreeSpaceExW = kernel32.NewProc("GetDiskFreeSpaceExW")
)

// searchTree walks root looking for names containing query (case-insensitive),
// returning matches as full-path entries. It is bounded in count and time so a
// search of C:\ on a huge disk cannot run forever.
func searchTree(root, query string, limit int, deadline time.Time) []entry {
	q := strings.ToLower(query)
	var out []entry
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable branches, keep going
		}
		if len(out) >= limit || time.Now().After(deadline) {
			return io.EOF // stop the walk
		}
		if strings.Contains(strings.ToLower(info.Name()), q) {
			out = append(out, entry{Name: p, IsDir: info.IsDir(), Size: info.Size(), Mtime: info.ModTime().UnixMilli()})
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// underInstallDir refuses any op whose target sits inside the agent's own program
// folder, so Files can never delete or overwrite the service that carries it.
func underInstallDir(path string) bool {
	install, err := filepath.Abs(config.InstallDir())
	if err != nil {
		return false
	}
	target, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	install = strings.ToLower(filepath.Clean(install))
	target = strings.ToLower(filepath.Clean(target))
	return target == install || strings.HasPrefix(target, install+string(filepath.Separator))
}
