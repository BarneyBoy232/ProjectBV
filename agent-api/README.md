# projectBV Agent API

A Cloudflare Worker that lets an AI drive the Windows fleet with an API key. The AI
gets an `ak_live_…` key; the Worker holds the signing secret and bridges each
request to the device over the signed Firestore bus. The AI never sees the signing
secret or Firebase.

## How it fits together

```
  Claude / any AI ──(ak_live_ key)──▶  Agent API Worker ──(signed cmd)──▶ Firestore bus ──▶ device agent (SYSTEM)
        ▲                                   │  holds AGENTAPI_TOKEN                               │ runs it, seals result
        └──────────── result ◀──────────────┘◀────────────── sealed result ◀──────────────────────┘
```

- **Signing secret** (`AGENTAPI_TOKEN`) lives only here and in the device binary
  (baked in from `agentApiToken` in the gitignored `internal/config/embedded-config.json`,
  never in source). It is never served to a browser, so a valid signature is itself
  proof the command came from this Worker.
- **A device does nothing until it is *armed*** from the projectBV dashboard
  (Agent API tool → arm the device). Arming requires an allow-listed operator.
- **Every command is audited** (device, action, which key, ok/error) for 30 days.

## One-time setup

```bash
cd agent-api
npm install

# 1) KV for keys + audit — paste the printed id into wrangler.toml
wrangler kv namespace create AGENTAPI_KV

# 2) The signing secret — must EQUAL agentApiToken in internal/config/embedded-config.json
wrangler secret put AGENTAPI_TOKEN

# 3) An admin token (any long random string) — the dashboard uses it to mint keys
wrangler secret put ADMIN_TOKEN

wrangler deploy
```

Note the deployed URL, e.g. `https://projectbv-agent-api.<you>.workers.dev`.

## Mint a key

Easiest: the projectBV dashboard → **Agent API** tool → paste the Worker URL + the
admin token once → **Mint key**. Or by hand:

```bash
curl -X POST https://<worker>/admin/keys \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"claude","devices":"all","caps":"full"}'
# -> { "key": "ak_live_...", ... }   (shown once)
```

`devices`: `"all"` or `["DESKTOP-1","LAPTOP-2"]`. `caps`: `"full"` or `"read"`.

## Connect Claude (MCP)

Add a custom connector pointing at the MCP endpoint. Two ways:

- **Key in the URL** (no header config): `https://<worker>/mcp/ak_live_...`
- **Header**: URL `https://<worker>/mcp`, header `Authorization: Bearer ak_live_...`

Claude then has tools: `list_devices`, `run_powershell`, `run_command`,
`read_file`, `write_file`, `list_dir`, `delete_path`, `machine_info`, `get_result`.

## Or call the REST API directly

```bash
curl -X POST https://<worker>/v1/exec \
  -H "Authorization: Bearer ak_live_..." \
  -H "Content-Type: application/json" \
  -d '{"device":"DESKTOP-1","line":"winget install 7zip.7zip --silent"}'
```

`GET /v1/devices` lists reachable devices. `POST /v1/{exec,read,write,list,delete,info}`
act on one. A long command returns `{pending,id}`; fetch it with
`GET /v1/result?device=…&id=…`.

## Security notes / known properties

- **Command lines travel as plaintext** on world-readable Firestore (signed, not
  sealed); results are AES-GCM sealed. Don't put literal secrets in an `exec` line —
  read them on-device instead. Sealing commands too is a planned hardening.
- **`exec` is unrestricted by design** (full SYSTEM). The only guard is that
  structured `write`/`delete` refuse the agent's own install/state folders, so the
  AI can't brick the agent and strand a device.
- Revoke a key (`DELETE /admin/keys?id=…`) or disarm a device to cut the AI off
  immediately.
- Only point this at devices you own or whose owner consented.
