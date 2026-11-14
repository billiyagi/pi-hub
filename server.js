// pi-hub: central relay. Amanda (or anything with the token) POSTs a run here;
// the hub forwards it over an already-open outbound WebSocket to the pi agent
// sitting on Billy's home/office host. No inbound port on those hosts.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PI_HUB_PORT || 8742);
const HOST = process.env.PI_HUB_HOST || '172.17.0.1';
const TOKEN = process.env.PI_HUB_TOKEN;
if (!TOKEN) {
  console.error('PI_HUB_TOKEN is required');
  process.exit(1);
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
  readFile(file, 'utf8')
    .then((text) => {
      res.writeHead(200, {
        'content-type': type,
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-cache',
      });
      res.end(text);
    })
    .catch(() => json(res, 404, { error: 'not found' }));
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
    return json(res, 401, { error: 'unauthorized' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/hosts') {
      return json(res, 200, { hosts: listAgents() });
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      const body = await readBody(req);
      const host = body.host || 'default';
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

    if (req.method === 'POST' && url.pathname === '/cancel') {
      const body = await readBody(req);
      const a = agents.get(body.host || 'default');
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
  if (!safeEq(token, TOKEN)) {
    ws.close(4401, 'unauthorized');
    return;
  }
  let name = url.searchParams.get('name') || 'default';

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      name = msg.name || name;
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

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const a of agents.values()) a.ws.close(1001, 'hub shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
