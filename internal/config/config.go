// Package config holds the agent's baked-in settings and the well-known paths
// it installs to. The settings live in embedded-config.json, which is compiled
// straight into every binary via go:embed — that is the "baked-in auth key"
// from the spec. Edit embedded-config.json before building for real.
package config

import (
	_ "embed"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

//go:embed embedded-config.json
var raw []byte

// Config is the small set of values the agent needs to run.
type Config struct {
	// AuthKey is a Tailscale auth key. Use a TAGGED, EPHEMERAL, REUSABLE key so
	// each device joins with least privilege and can be locked down by ACLs.
	AuthKey string `json:"authKey"`
	// FirebaseProjectID is your Firebase/Abstrak project (e.g. "runik-77e07").
	// The agent reads the manifest + writes its heartbeat there.
	FirebaseProjectID string `json:"firebaseProjectId"`
	// FirebaseAPIKey is the project's web apiKey (not a secret — access is
	// governed by Firestore rules).
	FirebaseAPIKey string `json:"firebaseApiKey"`
	// IntervalMinutes is how often the update loop checks the manifest.
	IntervalMinutes int `json:"intervalMinutes"`
	// HostnamePrefix names the node in the Tailscale admin console.
	HostnamePrefix string `json:"hostnamePrefix"`
	// AgentAPIToken is the Agent API tool's signing secret. It gates SYSTEM-level
	// control of a device, so it is a REAL secret: it lives here in the gitignored
	// embedded-config.json (never in source) and must equal the Agent API Worker's
	// AGENTAPI_TOKEN. Empty disables the Agent API tool — every command fails to
	// verify — which is the correct fail-closed default for an unconfigured agent.
	AgentAPIToken string `json:"agentApiToken"`
}

// ServiceName is the Windows service + display name. Deliberately the app's own
// name (not Tailscale's) and NOT disguised as anything else.
const ServiceName = "projectBV"

// Version is the agent's own version, shown in Programs & Features.
const Version = "1.2.0"

// Load parses the embedded config and fills in sensible defaults.
func Load() (Config, error) {
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	if c.IntervalMinutes <= 0 {
		c.IntervalMinutes = 30
	}
	if c.HostnamePrefix == "" {
		c.HostnamePrefix = "projectbv"
	}
	return c, nil
}

// InstallDir is the machine-wide program folder the agent is copied into,
// e.g. C:\Program Files\projectBV.
func InstallDir() string {
	base := os.Getenv("ProgramFiles")
	if base == "" {
		base = `C:\Program Files`
	}
	return filepath.Join(base, "projectBV")
}

// DataDir is where runtime state lives (tsnet state, update state, log).
//
// It prefers C:\ProgramData\projectBV, the machine-wide spot the service uses.
// But a standard-account (per-user) agent frequently cannot write there — the
// folder is often owned by SYSTEM from an admin install — and a data dir it
// cannot write is why the tunnel silently failed to persist its state and, with
// it, the whole agent looked dead. So when ProgramData isn't writable, fall back
// to the user's own LocalAppData, which they can always write. Both the agent and
// its per-user installer run as the same user, so they resolve to the same place.
// DryRun reports whether this agent should report in and read the manifest but
// never actually install anything. Set PROJECTBV_DRY_RUN=1 to run a simulated
// fleet device on a machine you do not want software landing on.
func DryRun() bool {
	v := os.Getenv("PROJECTBV_DRY_RUN")
	return v == "1" || strings.EqualFold(v, "true")
}

func DataDir() string {
	// A simulated device needs its own state, or several agents on one machine
	// would share one state.json and take turns reinstalling over each other.
	if d := os.Getenv("PROJECTBV_DATA_DIR"); d != "" {
		return d
	}
	base := os.Getenv("ProgramData")
	if base == "" {
		base = `C:\ProgramData`
	}
	shared := filepath.Join(base, "projectBV")
	if dirWritable(shared) {
		return shared
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		return filepath.Join(local, "projectBV", "data")
	}
	return shared
}

// dirWritable reports whether dir exists (creating it if it can) and this process
// can actually write a file into it.
func dirWritable(dir string) bool {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return false
	}
	f, err := os.CreateTemp(dir, ".write-test-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

// AgentExePath is the installed agent binary's full path (machine-wide install).
func AgentExePath() string {
	return filepath.Join(InstallDir(), "projectBV.exe")
}

// UserInstallDir is the per-user install folder (used when there's no admin),
// e.g. C:\Users\<you>\AppData\Local\projectBV.
func UserInstallDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	return filepath.Join(base, "projectBV")
}

// UserAgentExePath is the per-user installed agent path.
func UserAgentExePath() string {
	return filepath.Join(UserInstallDir(), "projectBV.exe")
}
