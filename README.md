# projectBV — One-Click Deploy Agent

A self-hosted fleet-deployment agent for Windows. You put it on a USB stick;
running it once installs a background agent that joins **your own** Tailscale
tailnet (headless, via `tsnet` — no Tailscale app, no login) and then keeps a set
of apps up to date from a JSON manifest you control.

## What it does

1. **USB install.** `projectBV-key.exe` (nuclear-trefoil icon) copies the agent
   into `C:\ProgramData\projectBV\agent` (hidden, admin-only), registers it as an always-on Windows
   service, and adds a Programs & Features entry. Silent (no window).
2. **Embedded Tailscale.** The agent runs a headless `tsnet` node that joins your
   tailnet automatically using a baked-in auth key. No separate install/UI/login.
3. **Manifest-driven updates.** Every N minutes it fetches your `manifest.json`,
   and for any listed app that's missing or outdated it downloads the installer,
   **verifies its SHA-256**, and installs it silently.
4. **No tray icon.** The agent is headless, running quietly as the `projectBV`
   service.

## What it deliberately does NOT do

This is an admin tool, built to stay on the right side of the line:

- **Discoverable, not hidden.** Real `projectBV.exe` process, a `projectBV`
  Windows service, a Programs & Features entry, and a plain-text log at
  `C:\ProgramData\projectBV\projectBV.log`. No process hiding, no anti-removal,
  no AV tampering.
- **Removable by the machine's owner.** Standard uninstall works
  (`sc stop projectBV && sc delete projectBV`, or Programs & Features, or the
  `projectBV-antidote.exe` on the USB). It cannot be made un-removable.
- **Manifest-only scope.** The manifest carries data only (name, version, url,
  sha256, optional silent args). Nothing in it is ever passed to a shell — no
  remote shell, no RDP, no arbitrary remote execution.
- **Deploy only on machines you own or whose owners have knowingly agreed** to a
  managed agent.

## Build

```powershell
# from the repo root
go run ./tools/genicon                                   # regenerate assets/trefoil.ico (optional)
go run github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest -64 `
  -o cmd/key/resource_windows_amd64.syso cmd/key/versioninfo.json   # embed trefoil into the key
.\build.ps1                                              # builds dist\ (all three, silent)
```

`build.ps1` produces, in `dist\`:

| File | Icon | Role |
|---|---|---|
| `projectBV-key.exe` | trefoil | the USB installer — **agent embedded inside, single file** |
| `projectBV.exe` | generic | the installed agent (service); embedded into the key at build |
| `projectBV-antidote.exe` | generic | one-click uninstaller |
| `projectBV-host.exe` | generic | deploy host you run on your own machine (console tool) |

## Configure before building

First copy the template (the real file is gitignored so your keys never get committed):

```powershell
copy internal\config\embedded-config.example.json internal\config\embedded-config.json
copy run-host.example.ps1 run-host.ps1
```

Then edit `internal/config/embedded-config.json` (it is compiled into the binaries):

```json
{
  "authKey": "tskey-auth-xxxxxxxxCNTRL-xxxxxxxxxxxxxxxxxxxxxxxxxx",
  "manifestURL": "http://deployhost:8080/manifest.json",
  "intervalMinutes": 30,
  "hostnamePrefix": "projectbv"
}
```

### Getting a Tailscale auth key

In the Tailscale admin console → **Settings → Keys → Generate auth key**:

- **Reusable** — the same key installs on many devices.
- **Ephemeral** — nodes clean themselves up when offline.
- **Tags** (e.g. `tag:projectbv`) — so ACLs can restrict these nodes to only
  reach your manifest/download host, nothing else on the tailnet.

Then, in your tailnet ACLs, allow `tag:projectbv` to reach only `deployhost`.

## Manifest format

Host a `manifest.json` (see `config/manifest.example.json`) on a machine in your
tailnet, alongside the installers:

```json
{
  "apps": [
    { "name": "ExampleApp", "version": "1.2.0",
      "url": "http://deployhost:8080/apps/ExampleApp-1.2.0.msi",
      "sha256": "<sha256 of the msi>" },
    { "name": "AnotherTool", "version": "3.0.1",
      "url": "http://deployhost:8080/apps/AnotherTool-Setup.exe",
      "sha256": "<sha256 of the exe>",
      "silentArgs": ["/VERYSILENT", "/NORESTART"] }
  ]
}
```

- `.msi` installs via `msiexec /i <file> /quiet /norestart`.
- `.exe` installs via `<file> /S` by default; override with `silentArgs`.
- Get a file's hash: `Get-FileHash .\installer.msi -Algorithm SHA256`.

## USB layout

```
USB:\
  projectBV-key.exe        <- ONE self-contained file: double-click to install
  projectBV-antidote.exe   <- double-click to uninstall (optional to carry)
```

The key has the agent embedded inside it, so it is a single file. Plug the USB
into a device, run the key once, approve the UAC prompt — done. Move to the next
device and run it again. The same key works on every device.

> **Note:** Windows blocks auto-run-on-insert for USB drives, so plugging the
> stick in won't launch anything by itself. Installing is a one-time double-click
> of the key; after that the service is always-on and auto-starts every boot.

## Deploy workflow (installing apps / files onto the fleet)

The device is only the client. To push apps or files, run the **deploy host** on
your own machine (joined to your tailnet) and drop things into it. The agent on
each device polls it and applies changes automatically.

```powershell
# On your own machine, in a folder where the deploy\ directory should live:

# add an app installer (msi/exe)
projectBV-host add-app  --name "AcmeTool" --version 1.2.0 --installer .\AcmeTool.msi
# add a file to drop onto every device (no execution)
projectBV-host add-file --name "AppConfig" --version 1.0.0 --src .\config.json `
  --dest "C:\ProgramData\MyApp\config.json"
# see what's currently published
projectBV-host list
# serve it to the fleet (leave running; --base is what the devices dialed)
projectBV-host serve --addr :8080                       # if this machine already runs Tailscale
# ...or serve straight onto your tailnet with NO Tailscale install needed:
projectBV-host serve --addr :8080 --tsnet --hostname deployhost --authkey tskey-auth-xxxx
```

**Do you need Tailscale installed?**

- On the **devices** you deploy to: never — the agent embeds it.
- On your **deploy host**: only if you *don't* use `--tsnet`. With `--tsnet` the
  host embeds Tailscale too (give it its own auth key), so nothing needs the
  Tailscale app installed anywhere. Register it as `deployhost` and it matches
  the default `manifestURL`.

- To **update** anything, re-run `add-app`/`add-file` with a higher `--version`.
  Within one poll interval every device downloads it, verifies the SHA-256, and
  applies it.
- `--dir` (default `deploy`) and `--base` (default `http://deployhost:8080`) are
  shared flags. `--base` must match the `manifestURL` host baked into the agent.
- The host machine needs to be reachable on your tailnet (run the normal
  Tailscale app on it, and point the agent's `manifestURL` at its MagicDNS name).

## Uninstall

Any of:

- Run `projectBV-antidote.exe` from the USB, or
- Settings → Apps → **projectBV** → Uninstall, or
- `sc stop projectBV` then `sc delete projectBV` and delete
  `C:\ProgramData\projectBV` (plus the pre-1.3.0 `C:\Program Files\projectBV`).

## Logs

`C:\ProgramData\projectBV\projectBV.log` — shows tailnet join, each manifest
check, and every install/update.
