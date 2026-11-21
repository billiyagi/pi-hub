// pi-hub agent: runs on the home/office host. Connects OUT to the hub over
// WebSocket, so no inbound port, no public IP, no VPN. Then it drives a local
// `pi` process in RPC mode (JSONL on stdin/stdout) for each run.
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import WebSocket from 'ws';

const HUB = process.env.PI_HUB_URL || 'ws://127.0.0.1:8742/agent';
const TOKEN = process.env.PI_HUB_TOKEN;
const NAME = process.env.PI_AGENT_NAME || 'default';
const PI_BIN = process.env.PI_BIN || 'pi';
const DEFAULT_MODEL = process.env.PI_MODEL || undefined;
const ROOT = process.env.PI_ALLOWED_ROOT || homedir();
const SESSION_DIR = process.env.PI_SESSION_DIR || path.join(homedir(), '.pi-hub', 'sessions');
const LOG_DIR = path.join(homedir(), '.pi-hub', 'logs');
const DEBUG = process.env.PI_DEBUG === '1';

if (!TOKEN) {
  console.error('PI_HUB_TOKEN is required');
  process.exit(1);
}
mkdirSync(SESSION_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });

const runLog = createWriteStream(path.join(LOG_DIR, 'agent.log'), { flags: 'a' });
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log(line);
  runLog.write(line + '\n');
};

let ws;
let busy = false;
/** @type {{proc: import('node:child_process').ChildProcess, runId: string} | null} */
let active = null;

function connect() {
  ws = new WebSocket(`${HUB}?token=${encodeURIComponent(TOKEN)}&name=${encodeURIComponent(NAME)}`);

  ws.on('open', () => {
    log(`[agent] connected to hub as "${NAME}"`);
    ws.send(
      JSON.stringify({
        type: 'hello',
        name: NAME,
        info: {
          host: path.basename(homedir()),
          platform: process.platform,
          arch: process.arch,
          root: ROOT,
          model: DEFAULT_MODEL || null,
          capabilities: ['run', 'exec'],
        },
      }),
    );
  });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'run') void handleRun(msg);
    if (msg.type === 'exec') void handleExec(msg);
    if (msg.type === 'cancel') {
      if (active && (!msg.id || msg.id === active.runId)) {
        active.proc.stdin?.write(JSON.stringify({ type: 'abort' }) + '\n');
      }
    }
  });

  ws.on('close', () => {
    log('[agent] hub connection closed, retrying in 3s');
    setTimeout(connect, 3000);
  });
  ws.on('error', (e) => log('[agent] ws error:', e.message));
}

// One run = one pi RPC process. --session-id keeps context between runs.
function runPi({ runId, cwd, message, model, sessionId, name, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = ['--mode', 'rpc', '--session-dir', SESSION_DIR];
    const realCwd = cwd ? path.resolve(ROOT, cwd) : ROOT;
    if (!realCwd.startsWith(path.resolve(ROOT))) {
      return reject(new Error(`cwd outside allowed root: ${realCwd}`));
    }
    if (model || DEFAULT_MODEL) args.push('--model', model || DEFAULT_MODEL);
    if (sessionId) args.push('--session-id', sessionId);
    if (name) args.push('--name', name);

    const proc = spawn(PI_BIN, args, {
      cwd: realCwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    active = { proc, runId };

    let text = '';
    let toolCalls = 0;
    let lastText = '';
    let settled = false;
    let stderr = '';
    let finished = false;

    const done = (err, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      active = null;
      try {
        proc.stdin?.write(JSON.stringify({ type: 'abort' }) + '\n');
      } catch {}
      try {
        proc.stdin?.end();
      } catch {}
      setTimeout(() => {
        try {
          proc.kill('SIGTERM');
        } catch {}
      }, 1500).unref();
      err ? reject(err) : resolve(result);
    };

    const timer = setTimeout(
      () => done(Object.assign(new Error(`pi run timed out after ${timeoutMs}ms`), { partial: text })),
      timeoutMs,
    );

    proc.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });

    proc.on('error', (e) => done(new Error(`failed to spawn pi: ${e.message}`)));
    proc.on('exit', (code) => {
      if (!settled) done(new Error(`pi exited early (code ${code}): ${stderr.trim().slice(-500)}`));
    });

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return;
      }
      if (DEBUG) log(`[run ${runId}] rec type=${rec.type}${rec.assistantMessageEvent ? '/' + rec.assistantMessageEvent.type : ''}`);
      if (rec.type === 'message_update') {
        const ev = rec.assistantMessageEvent || {};
        if (ev.type === 'text_delta' && ev.delta) text += ev.delta;
        return;
      }
      if (rec.type === 'tool_execution_start' || rec.type === 'tool_start') {
        toolCalls += 1;
        pushProgress({ runId, toolCalls, chars: text.length, phase: 'working' });
        return;
      }
      if (rec.type === 'agent_settled') {
        settled = true;
        // ask for the final text, then finish
        lastText = text;
        finish();
        return;
      }
      if (rec.type === 'response' && rec.command === 'get_last_assistant_text') {
        if (rec.success && rec.data?.text) lastText = rec.data.text;
        done(null, buildResult());
      }
    });

    let finishRequested = false;
    function finish() {
      if (finishRequested) return;
      finishRequested = true;
      proc.stdin.write(JSON.stringify({ id: 'final', type: 'get_last_assistant_text' }) + '\n');
      setTimeout(() => done(null, buildResult()), 5000).unref();
    }

    function buildResult() {
      return {
        text: (lastText || text).trim(),
        toolCalls,
        stderr: stderr.trim().slice(-800) || undefined,
      };
    }

    proc.stdin.write(JSON.stringify({ id: 'p1', type: 'prompt', message }) + '\n');
  });
}

function pushProgress(p) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'progress', ...p }));
}

// Verification verb: a plain shell command under the same allowed root. Amanda uses this to
// check the agent's work (git diff, tests, build) instead of trusting the run's own report.
function runShell({ command, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const realCwd = cwd ? path.resolve(ROOT, cwd) : ROOT;
    if (!realCwd.startsWith(path.resolve(ROOT))) {
      return reject(new Error(`cwd outside allowed root: ${realCwd}`));
    }
    const proc = spawn('/bin/bash', ['-lc', command], { cwd: realCwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const cap = (buf, chunk) => (buf + chunk).slice(-65_536);
    const finish = (exitCode, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut, cwd: realCwd });
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      finish(null, true);
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout = cap(stdout, d.toString())));
    proc.stderr.on('data', (d) => (stderr = cap(stderr, d.toString())));
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to run command: ${e.message}`));
    });
    proc.on('exit', (code) => finish(code, false));
  });
}

async function handleExec(msg) {
  if (busy) {
    ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'agent busy with another run' }));
    return;
  }
  busy = true;
  const started = Date.now();
  log(`[exec ${msg.id}] cwd=${msg.cwd || ROOT}`);
  try {
    const timeoutMs = Math.min(Number(msg.timeoutMs) || 120_000, 1_800_000);
    const result = await runShell({ ...msg, timeoutMs });
    log(`[exec ${msg.id}] exit=${result.exitCode} in ${Date.now() - started}ms`);
    ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, ...result, durationMs: Date.now() - started }));
  } catch (e) {
    log(`[exec ${msg.id}] error: ${e.message}`);
    ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: e.message }));
  } finally {
    busy = false;
  }
}

async function handleRun(msg) {
  if (busy) {
    ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: 'agent busy with another run' }));
    return;
  }
  busy = true;
  const started = Date.now();
  log(`[run ${msg.id}] start cwd=${msg.cwd || ROOT} model=${msg.model || DEFAULT_MODEL || 'default'}`);
  try {
    const timeoutMs = Math.min(Number(msg.timeoutMs) || 900_000, 3_600_000);
    const result = await runPi({ runId: msg.id, ...msg, timeoutMs });
    log(`[run ${msg.id}] ok in ${Date.now() - started}ms, tools=${result.toolCalls}`);
    ws.send(
      JSON.stringify({
        type: 'result',
        id: msg.id,
        ok: true,
        ...result,
        durationMs: Date.now() - started,
        cwd: msg.cwd ? path.resolve(ROOT, msg.cwd) : ROOT,
      }),
    );
  } catch (e) {
    log(`[run ${msg.id}] error: ${e.message}`);
    ws.send(
      JSON.stringify({
        type: 'result',
        id: msg.id,
        ok: false,
        error: e.message,
        partial: e.partial,
        durationMs: Date.now() - started,
      }),
    );
  } finally {
    busy = false;
  }
}

log(`[agent] starting name="${NAME}" hub=${HUB} root=${ROOT} pi=${PI_BIN}`);
connect();
