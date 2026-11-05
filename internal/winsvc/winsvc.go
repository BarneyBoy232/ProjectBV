// Package winsvc wires the agent into the Windows service manager via
// kardianos/service. The service is registered under the app's own name
// (projectBV), set to auto-start at every boot, and configured to restart
// itself if it ever crashes — that is the "always on / auto-starts" behaviour.
//
// Nothing here hides the service: it appears in services.msc and Task Manager
// under projectBV, exactly as a normal background service does.
package winsvc

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"projectbv/internal/agentapi"
	"projectbv/internal/config"
	"projectbv/internal/files"
	"projectbv/internal/firestore"
	"projectbv/internal/tailscale"
	"projectbv/internal/updater"

	"github.com/kardianos/service"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// program implements service.Interface.
type program struct {
	cfg    config.Config
	logger *log.Logger
	cancel context.CancelFunc
	done   chan struct{}

	// The tunnel node, once it is up. The heartbeat reads it every tick to include
	// the tailnet IP; it is nil until (and unless) Tailscale comes up, which never
	// holds the heartbeat back.
	nodeMu sync.Mutex
	node   *tailscale.Node
}

func (p *program) setNode(n *tailscale.Node) {
	p.nodeMu.Lock()
	p.node = n
	p.nodeMu.Unlock()
}

func (p *program) getNode() *tailscale.Node {
	p.nodeMu.Lock()
	defer p.nodeMu.Unlock()
	return p.node
}

// Start is called by the service manager. It must return promptly, so the real
// work runs in a background goroutine.
func (p *program) Start(s service.Service) error {
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.done = make(chan struct{})
	go p.run(ctx)
	return nil
}

// run does two independent jobs:
//   - deploy: read the manifest from Firebase and install/update apps (works over
//     the internet, so it does not depend on Tailscale),
//   - tunnel: bring up the embedded Tailscale node so this device is reachable on
//     the tailnet, and report its address via the heartbeat.
//
// Tailscale is best-effort: if it can't come up, deploys still run.
func (p *program) run(ctx context.Context) {
	defer close(p.done)

	fs := firestore.New(p.cfg.FirebaseProjectID, p.cfg.FirebaseAPIKey, http.DefaultClient)

	// Presence FIRST, and never gated on the tunnel. A device that can reach
	// Firebase must show as online even if Tailscale never comes up — otherwise a
	// machine whose tunnel state folder isn't writable (the standard-account case)
	// looks dead while it is perfectly alive.
	go p.heartbeatLoop(ctx, fs)

	// Files tool: browse/download/upload/reorganise this machine's disk from the
	// dashboard. Runs here in the service (LocalSystem, no login needed), which is
	// what lets it recover files from a device nobody can sign into.
	go files.Run(ctx, fs, http.DefaultClient, deviceID(), deviceID(), p.logger)

	// Agent API tool: lets an AI (connected through the Agent API Worker with an
	// API key) run arbitrary admin actions on this device. Dormant until the device
	// is armed from the dashboard; every command it accepts is signed by the Worker.
	// The signing secret comes from the gitignored embedded-config.json, not source.
	agentapi.Configure(p.cfg.AgentAPIToken)
	go agentapi.Run(ctx, fs, http.DefaultClient, deviceID(), deviceID(), p.logger)

	// Bring the tunnel up in the background, best-effort and time-bounded, so a
	// slow or failing tsnet can delay nothing else. The heartbeat picks up the
	// tailnet IP once the node is up.
	go func() {
		upCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
		defer cancel()
		if n, err := tailscale.Up(upCtx, p.cfg, p.logger); err != nil {
			p.logger.Printf("service: tailscale (tunnel) not up: %v — deploys and presence continue over the internet", err)
		} else {
			p.setNode(n)
			<-ctx.Done()
			n.Close()
		}
	}()

	// Deploy loop (blocks until ctx is cancelled). Pass this device's id so the
	// updater can honour per-device targeting in the manifest.
	updater.Run(ctx, fs, http.DefaultClient, p.cfg, deviceID(), p.logger)
}

// heartbeatLoop writes this device's check-in doc to Firebase every minute so it
// appears in the dashboard's "Connected devices" list, including its tailnet IP
// (the address other apps use to reach it through the tunnel).
func (p *program) heartbeatLoop(ctx context.Context, fs *firestore.Client) {
	id := deviceID()
	write := func() {
		fields := map[string]any{
			"name":     id,
			"version":  config.Version,
			"lastSeen": time.Now().UnixMilli(),
		}
		// Report how the last agent update went. Without this the console cannot
		// tell "hasn't checked in yet" from "updated, wouldn't run, rolled back" —
		// and the second one is the case worth knowing about.
		if u := updater.LastUpdate(); u != nil {
			fields["lastUpdateVersion"] = u.Version
			fields["lastUpdateResult"] = u.Result
			fields["lastUpdateAt"] = u.At
		}
		if node := p.getNode(); node != nil {
			if ip := node.IP(ctx); ip != "" {
				fields["tailnetIP"] = ip
			}
		}
		if err := fs.Set(ctx, "from_projectbv/fleet/devices/"+id, fields); err != nil {
			p.logger.Printf("service: heartbeat failed: %v", err)
		}
	}
	write()
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			write()
		}
	}
}

// deviceID is the machine's hostname, reduced to characters valid in a Firestore
// document id.
func deviceID() string {
	// Overridable so one machine can stand in for several fleet devices while
	// testing. Unset in every real install, where the hostname is the id.
	if id := os.Getenv("PROJECTBV_DEVICE_ID"); id != "" {
		return sanitiseID(id)
	}
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "device"
	}
	return sanitiseID(h)
}

// sanitiseID reduces a name to characters valid in a Firestore document id.
func sanitiseID(h string) string {
	var b strings.Builder
	for _, r := range h {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	return b.String()
}

// Stop is called by the service manager on shutdown/stop.
func (p *program) Stop(s service.Service) error {
	if p.cancel != nil {
		p.cancel()
	}
	if p.done != nil {
		select {
		case <-p.done:
		case <-time.After(10 * time.Second):
		}
	}
	return nil
}

// build returns a configured service.Service plus the program instance.
func build(logger *log.Logger) (service.Service, *program, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, nil, err
	}
	prg := &program{cfg: cfg, logger: logger}

	svcConfig := &service.Config{
		Name:        config.ServiceName,
		DisplayName: config.ServiceName,
		Description: "projectBV deploy agent: keeps managed apps up to date over a private tailnet.",
		// The installed agent binary is the service executable.
		Executable: config.AgentExePath(),
		Option: service.KeyValue{
			// Start automatically at boot.
			"StartType": "automatic",
			// Restart the service if it exits unexpectedly (always-on).
			"OnFailure":              "restart",
			"OnFailureDelayDuration": "5s",
			"OnFailureResetPeriod":   "60s",
		},
	}
	s, err := service.New(prg, svcConfig)
	if err != nil {
		return nil, nil, err
	}
	return s, prg, nil
}

// RunService runs the agent under the service manager (the default mode).
func RunService(logger *log.Logger) error {
	s, _, err := build(logger)
	if err != nil {
		return err
	}
	return s.Run()
}

// Control performs an install/uninstall/start/stop action by name.
func Control(logger *log.Logger, action string) error {
	s, _, err := build(logger)
	if err != nil {
		return err
	}
	return service.Control(s, action)
}

// Running reports nil only if the service is in the RUNNING state right now.
//
// It asks Windows directly rather than going through the service library, which
// reports "start pending" as running — and a crash-looping agent spends most of
// its life in start-pending, because the service is configured to restart itself
// on failure. Treating that as success would be how a broken build gets accepted.
func Running() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(config.ServiceName)
	if err != nil {
		return err
	}
	defer s.Close()
	st, err := s.Query()
	if err != nil {
		return err
	}
	if st.State != svc.Running {
		return fmt.Errorf("service state is %v, not running", st.State)
	}
	return nil
}

// PointAt changes which executable the service runs.
//
// This is the last resort when replacing the agent goes wrong: if the new binary
// won't run and the old one cannot be copied back into place, the service is
// pointed straight at the surviving backup copy instead. The device keeps a
// working agent — and therefore keeps being fixable from the dashboard — rather
// than needing someone to walk over to it.
func PointAt(exePath string) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(config.ServiceName)
	if err != nil {
		return err
	}
	defer s.Close()
	cfg, err := s.Config()
	if err != nil {
		return err
	}
	// Quote it. An unquoted path with spaces ("C:\Program Files\projectBV\...")
	// lets Windows try "C:\Program.exe" first, which is both a startup failure and
	// a well-known hijack: anything droppable at that path would run as SYSTEM.
	quoted := quotePath(exePath)
	if cfg.BinaryPathName == quoted {
		return nil
	}
	cfg.BinaryPathName = quoted
	return s.UpdateConfig(cfg)
}

// ErrNotInstalled means the service is genuinely absent — as opposed to present
// but unreadable, which callers must treat very differently: "not installed" is a
// normal state, "cannot tell" is a reason to leave the device alone.
var ErrNotInstalled = fmt.Errorf("the %s service is not installed", config.ServiceName)

// ImagePath is the executable the service is currently configured to run, with
// any quoting removed. It returns ErrNotInstalled if there is no such service.
func ImagePath() (string, error) {
	m, err := mgr.Connect()
	if err != nil {
		return "", err
	}
	defer m.Disconnect()
	s, err := m.OpenService(config.ServiceName)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return "", ErrNotInstalled
		}
		return "", err
	}
	defer s.Close()
	cfg, err := s.Config()
	if err != nil {
		return "", err
	}
	return strings.Trim(strings.TrimSpace(cfg.BinaryPathName), `"`), nil
}

func quotePath(p string) string {
	return `"` + strings.Trim(p, `"`) + `"`
}

// StaysRunning reports nil if the service is running and still running after the
// given settle time, sampled throughout. An agent that starts and then dies —
// missing dependency, bad config, immediate panic — fails this, which is the
// signal to put the previous binary back.
func StaysRunning(settle time.Duration) error {
	deadline := time.Now().Add(settle)
	for {
		if err := Running(); err != nil {
			return err
		}
		if time.Now().After(deadline) {
			return nil
		}
		time.Sleep(3 * time.Second)
	}
}
