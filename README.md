# pi-hub — remote Pi coding agents

Hub-and-spoke: a public WebSocket hub on the VPS, agents on home/office hosts that
dial **out** (no inbound port, no VPN, no public IP).

- Hub: `https://pi.billycloud.my.id` (Caddy → `172.17.0.1:8742`, ufw allows only the `edge` docker network)
- Services: `pi-hub.service` (server.js) + `pi-hub-agent.service` (this VPS as host `vps`), both `systemctl --user`, linger enabled
- Gateway auth: `Authorization: Bearer $PI_HUB_TOKEN` for everything except `/health` and the bootstrap files

## Install on a new host

```bash
curl -fsSL https://pi.billycloud.my.id/install.sh \
  | bash -s -- --token <HUB_TOKEN> --key <PI_BILLY_KEY> --name rumah
```

Both `--token` and `--key` are required. `--key` is the model-provider key; the
installer bakes it into `~/.pi-hub.env` **and** `~/.pi/agent/models.json`.

Other flags: `--hub wss://…/agent`, `--model billy/amanda-agent`, `--root <allowed dir>`,
`--dir <install dir>`. Env passthrough: `PI_API_BASE` (default `https://ai.billycloud.my.id/v1`),
`PI_NO_SERVICE=1` to skip the systemd unit.

## API

```bash
# health (public)
curl https://pi.billycloud.my.id/health

# connected hosts
curl -H "Authorization: Bearer $PI_HUB_TOKEN" https://pi.billycloud.my.id/hosts

# run a prompt on one host
curl -X POST https://pi.billycloud.my.id/run \
  -H "Authorization: Bearer $PI_HUB_TOKEN" -H 'content-type: application/json' \
  -d '{"host":"rumah","message":"list files in this dir","cwd":".","timeoutMs":120000}'
```

Response: `{"type":"result","ok":true,"text":"…","toolCalls":N,"durationMs":N,"cwd":"…"}`.

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
