package agentapi

import (
	"bytes"
	"context"
	"os/exec"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

// maxOutput caps each of stdout/stderr so a runaway command (a recursive dir, a
// huge log) can never produce a result too big for Firestore's ~1MB document cap
// once sealed + base64'd. The AI is told when output was cut.
const maxOutput = 128 * 1024

// execResult is what an `exec` command returns to the AI.
type execResult struct {
	Exit           int    `json:"exit"`
	Stdout         string `json:"stdout"`
	Stderr         string `json:"stderr"`
	StdoutTrimmed  bool   `json:"stdoutTruncated,omitempty"`
	StderrTrimmed  bool   `json:"stderrTruncated,omitempty"`
	TimedOut       bool   `json:"timedOut,omitempty"`
}

// runExec runs a command and captures its output. It runs AS THE SERVICE — i.e.
// LocalSystem, full administrator — so "install software", "edit the registry",
// "stop a service", "add a user" are all just ordinary commands here.
//
// shell picks the interpreter:
//
//	"powershell" (default) — powershell.exe -Command <line>
//	"cmd"                  — cmd.exe /C <line>
//	""  with a program     — run `program` directly with args[]
//
// A command that overruns timeoutMs (default 120s, hard cap 600s) is killed and
// flagged TimedOut, so a hung installer can never wedge the device's command loop.
func runExec(ctx context.Context, shell, line, program string, args []string, cwd string, timeoutMs int64) execResult {
	if timeoutMs <= 0 {
		timeoutMs = 120_000
	}
	if timeoutMs > 600_000 {
		timeoutMs = 600_000
	}
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	var cmd *exec.Cmd
	switch {
	case program != "":
		cmd = exec.CommandContext(runCtx, program, args...)
	case shell == "cmd":
		cmd = exec.CommandContext(runCtx, "cmd.exe", "/C", line)
	default: // powershell
		cmd = exec.CommandContext(runCtx, "powershell.exe",
			"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", line)
	}
	if cwd != "" {
		cmd.Dir = cwd
	}
	// No console window, and its own process group so a timeout kill takes children
	// (an installer's spawned msiexec, say) down with it rather than orphaning them.
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NO_WINDOW | windows.CREATE_NEW_PROCESS_GROUP,
	}

	var out, errb capBuf
	out.limit, errb.limit = maxOutput, maxOutput
	cmd.Stdout = &out
	cmd.Stderr = &errb

	err := cmd.Run()
	res := execResult{
		Stdout:        out.String(),
		Stderr:        errb.String(),
		StdoutTrimmed: out.trimmed,
		StderrTrimmed: errb.trimmed,
		Exit:          exitCode(cmd, err),
	}
	if runCtx.Err() == context.DeadlineExceeded {
		res.TimedOut = true
	}
	return res
}

// exitCode pulls the process exit code out, distinguishing "ran and exited
// non-zero" (a normal, reportable outcome) from "could not start at all".
func exitCode(cmd *exec.Cmd, err error) int {
	if err == nil {
		return 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	// Failed to launch (bad path, etc.): -1, with the reason already surfaced to the
	// AI via stderr by the caller when relevant.
	return -1
}

// capBuf is a bytes.Buffer that stops accepting data past a cap, recording that it
// did. It keeps output bounded without failing the whole command.
type capBuf struct {
	buf     bytes.Buffer
	limit   int
	trimmed bool
}

func (c *capBuf) Write(p []byte) (int, error) {
	if room := c.limit - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
			c.trimmed = true
		} else {
			c.buf.Write(p)
		}
	} else if len(p) > 0 {
		c.trimmed = true
	}
	// Always claim the full write so the child process is never blocked by our cap.
	return len(p), nil
}

func (c *capBuf) String() string { return c.buf.String() }
