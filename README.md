# pi-hub — remote Pi coding agents

Hub-and-spoke: a public WebSocket hub on the VPS, agents on home/office hosts that
dial **out** (no inbound port, no VPN, no public IP).

- Hub: `https://pi.billycloud.my.id` (Caddy → `172.17.0.1:8742`, ufw allows only the `edge` docker network)
- Services: `pi-hub.service` (server.js) + `pi-hub-agent.service` (this VPS as host `vps`), both `systemctl --user`, linger enabled
- Gateway auth: `Authorization: Bearer $PI_HUB_TOKEN` for everything except `/health` and the bootstrap files

## Install on a new host

```bash
# 1. on the hub: mint a token for that host
cd ~/pi-hub && node agents.mjs add rumah --root '$HOME'

# 2. on the host: paste the command it prints
curl -fsSL https://pi.billycloud.my.id/install.sh \
  | bash -s -- --token <AGENT_TOKEN> --name rumah
```

No `--key`: the installer fetches `GET /bootstrap/models.json` with that token and writes it to
`~/.pi/agent/models.json`, so the provider key never appears in a command line, shell history or
chat. `$VAR` apiKey placeholders in the hub's own config are resolved server-side before sending.
Pass `--key` only to override with a different provider key.

`--name` should equal the name you registered — the hub takes the name from the token anyway, so
a mismatch only confuses logs.

Other flags: `--hub wss://…/agent`, `--model billy/amanda-agent`, `--root <allowed dir>`,
`--dir <install dir>`. Env passthrough: `PI_API_BASE` (default `https://ai.billycloud.my.id/v1`),
`PI_NO_SERVICE=1` to skip the systemd unit.

## Per-agent tokens (one per host, revocable)

The master `PI_HUB_TOKEN` still works, but a host should get its **own** token: the token *is*
the agent's identity, so a client can never claim another agent's name, and one leaked host
does not compromise the rest.

```bash
cd ~/pi-hub
node agents.mjs add rumah --root /home/billy/work   # prints token + install command
node agents.mjs list
node agents.mjs revoke rumah                        # 401 at once, socket dropped within 30 s
```

State: `~/.pi-hub/agents.json` (chmod 600).

## API

```bash
# health (public)
curl https://pi.billycloud.my.id/health

# connected hosts (live sockets)
curl -H "Authorization: Bearer ***" https://pi.billycloud.my.id/hosts

# registry (persisted, online flag)
curl -H "Authorization: Bearer ***" https://pi.billycloud.my.id/agents

# model config for a new host (auth required: the file holds the provider key)
curl -H "Authorization: Bearer ***" https://pi.billycloud.my.id/bootstrap/models.json

# run a prompt on one host
curl -X POST https://pi.billycloud.my.id/run \
  -H "Authorization: Bearer ***" -H 'content-type: application/json' \
  -d '{"host":"rumah","message":"list files in this dir","cwd":".","timeoutMs":120000}'

# verify with a plain shell command (same allowed root, no agent in the loop)
curl -X POST https://pi.billycloud.my.id/exec \
  -H "Authorization: Bearer ***" -H 'content-type: application/json' \
  -d '{"host":"rumah","command":"git status --short && npm test","cwd":"app","timeoutMs":120000}'
```

Response `run`: `{"type":"result","ok":true,"text":"…","toolCalls":N,"durationMs":N,"cwd":"…"}`.
Response `exec`: `{"type":"result","ok":true,"stdout":"…","stderr":"…","exitCode":N,"timedOut":false,"cwd":"…"}`.

With a per-agent token, omit `host`: the token pins the request to its own agent, and `host`
in the body is ignored. One run per agent at a time — a second request while busy fails with
`agent busy with another run`.

## Gotchas (learned the hard way)

1. **pi does not read model config from env.** Providers/models live in
   `~/.pi/agent/models.json`. An installer that only writes `PI_BILLY_KEY` to the env
   file produces runs that either hang until timeout or fail with
   `Model "billy/<x>" not found`. The installer now generates that file (merging, keeping
   other providers) and fetches the live model list from `/v1/models` using the key.
2. **`pi --mode rpc` exits as soon as stdin hits EOF.** The bridge must keep stdin open,
   otherwise the reply never arrives.
3. **`PI_ALLOWED_ROOT` is enforced**; `cwd` is resolved against it and rejected outside.
4. Restart after editing bridge code: `systemctl --user restart pi-hub-agent`.
5. Debug a run: `PI_DEBUG=1` in `~/.pi-hub.env` → logs every record type in `~/.pi-hub/logs/agent.log`.
