#!/usr/bin/env bash
# pi-hub agent installer — run this ON the home/office host.
#
#   curl -fsSL https://pi.billycloud.my.id/install.sh \
#     | bash -s -- --token <AGENT_TOKEN> --name rumah [--root <dir>]
#
# No --key needed: the model config (provider key included) is copied from the hub over the
# same token-authenticated channel. Pass --key only to override it.
#
# Installs the `pi` coding agent plus this agent bridge, then dials OUT to the
# hub over WebSocket. No inbound port, no public IP, no VPN needed.
set -euo pipefail

HUB_URL="wss://pi.billycloud.my.id/agent"
NAME="$(hostname -s 2>/dev/null || echo host)"
TOKEN="${PI_HUB_TOKEN:-}"
KEY="${PI_BILLY_KEY:-}"
MODEL="${PI_MODEL:-billy/amanda-agent}"
ALLOWED_ROOT="${PI_ALLOWED_ROOT:-$HOME}"
DIR="${PI_DIR:-$HOME/pi-hub}"

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --key)   KEY="${2:-}";   shift 2 ;;
    --name)  NAME="${2:-}";  shift 2 ;;
    --hub)   HUB_URL="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --root)  ALLOWED_ROOT="${2:-}"; shift 2 ;;
    --dir)   DIR="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TOKEN" ] || { echo "error: --token <HUB_TOKEN> is required (ask Amanda)" >&2; exit 1; }
# No --key: pull the hub's own ~/.pi/agent/models.json over the authenticated bootstrap
# endpoint, so the provider key never appears in a command, shell history or chat.

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# HTTP base for fetching bootstrap files, derived from the WS hub URL.
# wss://host/agent -> https://host ; ws://h:p/agent -> http://h:p
HTTP_BASE="$(printf '%s' "$HUB_URL" | sed -e 's#^wss://#https://#' -e 's#^ws://#http://#' -e 's#/agent/*$##')"

# --- node ---------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  say "node not found, installing Node 22"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
    sudo apt-get install -y nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y nodejs >/dev/null
  elif command -v brew >/dev/null 2>&1; then
    brew install node >/dev/null
  else
    die "install Node >= 20 manually, then rerun"
  fi
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node $(node -v) too old, need >= 20"

# --- code ---------------------------------------------------------------
say "installing pi-hub into $DIR"
mkdir -p "$DIR"

# Prefer files next to this script (running from a repo checkout); otherwise
# pull them from the hub, which serves them publicly.
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null || echo .)"
# Only trust files next to the script when it is a real path (not `curl | bash`, where
# BASH_SOURCE is empty and "." would silently copy whatever happens to sit in $PWD).
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then :; else SELF_DIR=/nonexistent; fi
for f in package.json agent.js; do
  if [ -f "$SELF_DIR/$f" ] && [ "$SELF_DIR" != "$DIR" ]; then
    cp "$SELF_DIR/$f" "$DIR/$f"
  else
    curl -fsSL "$HTTP_BASE/$f" -o "$DIR/$f" || die "could not fetch $f from $HTTP_BASE"
  fi
done

cd "$DIR"
say "npm install (pi + ws, may take a minute)"
npm install --omit=dev --no-audit --no-fund --loglevel=error

PI_BIN_PATH="$DIR/node_modules/.bin/pi"
[ -x "$PI_BIN_PATH" ] || die "pi binary missing at $PI_BIN_PATH"

# --- config -------------------------------------------------------------
say "writing ~/.pi-hub.env"
umask 077
cat > "$HOME/.pi-hub.env" <<EOF
PI_HUB_TOKEN=$TOKEN
PI_BILLY_KEY=$KEY
PI_HUB_URL=$HUB_URL
PI_AGENT_NAME=$NAME
PI_BIN=$PI_BIN_PATH
PI_MODEL=$MODEL
PI_ALLOWED_ROOT=$ALLOWED_ROOT
EOF
chmod 600 "$HOME/.pi-hub.env"

# --- pi provider config -------------------------------------------------
# pi resolves models from ~/.pi/agent/models.json, not from env vars. Without
# this file every run fails with 'Model "…" not found'.
say "configuring pi provider (billy) in ~/.pi/agent/models.json"
mkdir -p "$HOME/.pi/agent"
PI_API_BASE="${PI_API_BASE:-https://ai.billycloud.my.id/v1}"
if [ -z "$KEY" ]; then
  say "no --key: copying model config from the hub (over TLS, token-authenticated)"
  TMP="$(mktemp)"
  curl -fsS -H "Authorization: Bearer $TOKEN" "$HTTP_BASE/bootstrap/models.json" -o "$TMP" \
    || { rm -f "$TMP"; die "could not fetch /bootstrap/models.json — token valid? hub has a model config?"; }
  chmod 600 "$TMP"
  mkdir -p "$HOME/.pi/agent"
  mv "$TMP" "$HOME/.pi/agent/models.json"
  KEY="$(node -e 'const c=require(process.argv[1]);const p=c.providers[process.argv[2]]||{};process.stdout.write(p.apiKey||"")' "$HOME/.pi/agent/models.json" "${MODEL%%/*}")"
  [ -n "$KEY" ] || die "hub config has no provider '${MODEL%%/*}'"
  echo "   provider '${MODEL%%/*}' copied from hub"
else
node - "$KEY" "$PI_API_BASE" "$MODEL" <<'NODE'
const fs = require('fs');
const path = require('path');
const [key, apiBase, model] = process.argv.slice(2);
const [providerName, ...rest] = model.split('/');
const modelId = rest.join('/');
const file = path.join(process.env.HOME, '.pi', 'agent', 'models.json');

let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
cfg.providers = cfg.providers || {};

(async () => {
  const ids = new Set([modelId]);
  const meta = new Map(); // id -> { contextWindow, maxTokens, input }
  try {
    const res = await fetch(apiBase + '/models', {
      headers: { authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    for (const m of data.data || []) {
      const id = typeof m === 'string' ? m : m.id;
      // Only flat ids belong to the named provider (skip 'kc/anthropic/…').
      if (!id || id.includes('/')) continue;
      ids.add(id);
      if (typeof m === 'string') continue;
      const cap = m.capabilities || {};
      // 9router reports real limits at the top level; fall back to capabilities.
      meta.set(id, {
        contextWindow: m.context_length || cap.contextWindow,
        maxTokens: m.max_completion_tokens || cap.maxOutput,
        input: cap.vision === false ? ['text'] : ['text', 'image'],
      });
    }
  } catch (err) {
    console.error('warn: could not list models from ' + apiBase + ' (' + err.message + '); using ' + modelId);
  }

  cfg.providers[providerName] = {
    baseUrl: apiBase,
    api: 'openai-completions',
    apiKey: key,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [...ids].map((id) => {
      const m = meta.get(id) || {};
      return {
        id,
        name: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        contextWindow: m.contextWindow || 200000,
        maxTokens: m.maxTokens || 16384,
        // Omit this and Pi treats the model as text-only and drops image blocks.
        input: m.input || ['text', 'image'],
      };
    }),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  console.log(`   provider "${providerName}" -> ${apiBase} (${cfg.providers[providerName].models.length} models)`);
})();
NODE
fi

# --- service ------------------------------------------------------------
if [ "${PI_NO_SERVICE:-0}" != "1" ] \
   && command -v systemctl >/dev/null 2>&1 \
   && systemctl --user show-environment >/dev/null 2>&1; then
  say "installing systemd user unit"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/pi-hub-agent.service" <<UNIT
[Unit]
Description=pi agent -> pi-hub relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$HOME/.pi-hub.env
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/agent.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT

  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  systemctl --user daemon-reload
  systemctl --user enable --now pi-hub-agent.service
  sleep 2
  systemctl --user --no-pager --lines=0 status pi-hub-agent.service 2>/dev/null || true
elif [ "${PI_NO_SERVICE:-0}" = "1" ]; then
  say "service install skipped (PI_NO_SERVICE=1)"
else
  say "no systemd user session; starting agent with nohup"
  mkdir -p "$HOME/.pi-hub"
  set -a; . "$HOME/.pi-hub.env"; set +a
  nohup node "$DIR/agent.js" >> "$HOME/.pi-hub/agent.out" 2>&1 &
  sleep 4
  tail -5 "$HOME/.pi-hub/agent.out" 2>/dev/null || true
fi

say "done. host \"$NAME\" should now be online:"
say "  curl -H 'Authorization: Bearer <token>' ${HTTP_BASE}/hosts"
