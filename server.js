// pi-hub: central relay. Amanda (or anything with the token) POSTs a run here;
// the hub forwards it over an already-open outbound WebSocket to the pi agent
// sitting on Billy's home/office host. No inbound port on those hosts.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PI_HUB_PORT || 8742);
const HOST = process.env.PI_HUB_HOST || '172.17.0.1';
const TOKEN = process.env.PI_HUB_TOKEN;
if (!TOKEN) {
  console.error('PI_HUB_TOKEN is required');
  process.exit(1);
}

// Per-agent tokens: a token *is* the agent's identity, so a client can never claim another
// agent's name. Managed with `node agents.mjs add|list|revoke <name>`.
const STATE = process.env.PI_HUB_STATE || path.join(homedir(), '.pi-hub', 'agents.json');

function registry() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8')).agents || {};
  } catch {
    return {};
  }
}

function agentByToken(token) {
  if (!token) return null;
  for (const [name, a] of Object.entries(registry())) {
    if (a?.revokedAt) continue;
    if (safeEq(token, a?.token)) return name;
  }
  return null;
}

/** @type {Map<string, {ws: import('ws').WebSocket, info: any, connectedAt: number}>} */
const agents = new Map();
/** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout, onProgress?: Function}>} */
const pending = new Map();

const safeEq = (a = '', b = '') => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`invalid json: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

// Public bootstrap files so a new host can install with a single curl.
const PUBLIC_FILES = {
  '/install.sh': 'install.sh',
  '/agent.js': 'agent.js',
  '/package.json': 'package.json',
};

function serveFile(res, name, type) {
  const file = new URL(`./${name}`, import.meta.url);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return json(res, 404, { error: 'not found' });
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-cache',
  });
  res.end(text);
}

function listAgents() {
  return [...agents.entries()].map(([name, a]) => ({
    name,
    connectedAt: new Date(a.connectedAt).toISOString(),
    ...a.info,
  }));
}

function dispatch(host, payload, timeoutMs, onProgress) {
  const a = agents.get(host);
  if (!a) {
    const known = [...agents.keys()];
    const err = new Error(
      known.length
        ? `host "${host}" is not connected. online: ${known.join(', ')}`
        : 'no agents connected',
    );
    err.status = 503;
    throw err;
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`run timed out after ${timeoutMs}ms`), { status: 504 }));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, onProgress });
    a.ws.send(JSON.stringify({ id, ...payload }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') return json(res, 200, { ok: true, agents: listAgents() });

  // Bootstrap files: public, no token (install.sh is useless if it needs the token to fetch).
  const pub = PUBLIC_FILES[url.pathname];
  if (req.method === 'GET' && pub) {
    return serveFile(res, pub, pub.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8');
  }

  if (!safeEq(req.headers.authorization?.replace(/^Bearer\s+/i, ''), TOKEN)) {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const pinned = agentByToken(bearer);
    if (!pinned) return json(res, 401, { error: 'unauthorized' });
    // An agent's own token may only act as itself.
    req.pinnedHost = pinned;
  }

  try {
    // Model config for a new host. Authenticated on purpose: the file carries the provider
    // key, so it must never sit in a public bootstrap path nor travel in a shell command.
    if (req.method === 'GET' && url.pathname === '/bootstrap/models.json') {
      let cfg;
      try {
        cfg = JSON.parse(readFileSync(path.join(homedir(), '.pi', 'agent', 'models.json'), 'utf8'));
      } catch {
        return json(res, 404, { error: 'hub has no ~/.pi/agent/models.json' });
      }
      // The hub's own file may hold a placeholder like "$PI_BILLY_KEY"; hand out the resolved
      // value so the new host never needs the key in a command line.
      for (const p of Object.values(cfg.providers || {})) {
        if (typeof p.apiKey === 'string' && p.apiKey.startsWith('$')) {
          const name = p.apiKey.replace(/^\$\{?|\}$/g, '');
          if (process.env[name]) p.apiKey = process.env[name];
        }
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(cfg));
    }

    if (req.method === 'GET' && url.pathname === '/hosts') {
      return json(res, 200, { hosts: listAgents() });
    }

    if (req.method === 'GET' && url.pathname === '/agents') {
      const online = new Set(agents.keys());
      return json(res, 200, {
        agents: Object.entries(registry()).map(([name, a]) => ({
          name,
          online: online.has(name),
          createdAt: a?.createdAt || null,
          revokedAt: a?.revokedAt || null,
          lastSeenAt: a?.lastSeenAt || null,
        })),
      });
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      const body = await readBody(req);
      const host = req.pinnedHost || body.host || 'default';
      const message = String(body.message || '').trim();
      if (!message) return json(res, 400, { error: 'message is required' });
      const timeoutMs = Math.min(Number(body.timeoutMs) || 900_000, 3_600_000);
      const payload = {
        type: 'run',
        cwd: body.cwd || undefined,
        message,
        model: body.model || undefined,
        sessionId: body.sessionId || undefined,
        name: body.name || undefined,
      };
      const result = await dispatch(host, payload, timeoutMs);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/exec') {
      const body = await readBody(req);
      const command = String(body.command || '').trim();
      if (!command) return json(res, 400, { error: 'command is required' });
      const host = req.pinnedHost || body.host || 'default';
      const timeoutMs = Math.min(Number(body.timeoutMs) || 120_000, 1_800_000);
      const result = await dispatch(
        host,
        { type: 'exec', command, cwd: body.cwd || undefined, timeoutMs },
        timeoutMs + 15_000,
      );
      return json(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/cancel') {
      const body = await readBody(req);
      const a = agents.get(req.pinnedHost || body.host || 'default');
      if (!a) return json(res, 404, { error: 'host not connected' });
      a.ws.send(JSON.stringify({ type: 'cancel', id: body.id }));
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  }
});

const wss = new WebSocketServer({ server, path: '/agent' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token') || req.headers['x-pi-token'];
  const isMaster = safeEq(token, TOKEN);
  const pinnedName = isMaster ? null : agentByToken(token);
  if (!isMaster && !pinnedName) {
    ws.close(4401, 'unauthorized');
    return;
  }
  let name = pinnedName || url.searchParams.get('name') || 'default';

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      name = pinnedName || msg.name || name;
      agents.set(name, { ws, info: msg.info || {}, connectedAt: Date.now() });
      console.log(`[hub] agent online: ${name} ${JSON.stringify(msg.info || {})}`);
      ws.send(JSON.stringify({ type: 'hello-ok', name }));
      return;
    }
    if (msg.type === 'progress') {
      pending.get(msg.id)?.onProgress?.(msg);
      return;
    }
    if (msg.type === 'result') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg);
      else p.reject(Object.assign(new Error(msg.error || 'agent error'), { status: 502, detail: msg }));
    }
  });

  ws.on('close', () => {
    if (agents.get(name)?.ws === ws) {
      agents.delete(name);
      console.log(`[hub] agent offline: ${name}`);
    }
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(Object.assign(new Error('agent disconnected mid-run'), { status: 502 }));
    }
  });
  ws.on('error', () => {});
});

server.listen(PORT, HOST, () => console.log(`[hub] listening on ${HOST}:${PORT}`));

// A revoked token must stop working now, not on the agent's next reconnect.
setInterval(() => {
  const reg = registry();
  for (const [name, a] of agents) {
    if (reg[name]?.revokedAt) {
      a.ws.close(4401, 'revoked');
      agents.delete(name);
      console.log(`[hub] agent revoked and dropped: ${name}`);
    }
  }
}, 30_000).unref();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const a of agents.values()) a.ws.close(1001, 'hub shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
