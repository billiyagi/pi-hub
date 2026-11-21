#!/usr/bin/env node
// Agent registry for pi-hub. One token per agent, revocable, and the token IS the identity —
// the hub never trusts a name sent by the client.
//
//   node agents.mjs add <name> [--root <path>]   # prints token + install command
//   node agents.mjs list
//   node agents.mjs revoke <name>
//
// State: $PI_HUB_STATE or ~/.pi-hub/agents.json (chmod 600).
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const STATE = process.env.PI_HUB_STATE || path.join(homedir(), '.pi-hub', 'agents.json');
const HUB = process.env.PI_HUB_PUBLIC || 'https://pi.billycloud.my.id';

const read = () => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return { agents: {} };
  }
};
const write = (state) => {
  mkdirSync(path.dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  chmodSync(STATE, 0o600);
};
const fail = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

const [cmd, name, ...rest] = process.argv.slice(2);
const state = read();
state.agents ||= {};

if (cmd === 'add') {
  if (!name) fail('usage: agents.mjs add <name> [--root <path>]');
  if (state.agents[name] && !state.agents[name].revokedAt) fail(`agent "${name}" already exists (revoke it first)`);
  const rootIdx = rest.indexOf('--root');
  const root = rootIdx >= 0 ? rest[rootIdx + 1] : null;
  const token = `pha_${randomBytes(24).toString('base64url')}`;
  state.agents[name] = { token, createdAt: new Date().toISOString(), revokedAt: null, root };
  write(state);
  const rootArg = root ? ` --root ${root}` : '';
  console.log(`agent: ${name}`);
  console.log(`token: ${token}`);
  console.log('');
  console.log('install on that host:');
  console.log(`  curl -fsSL ${HUB}/install.sh | bash -s -- --token ${token} --key <PI_BILLY_KEY> --name ${name}${rootArg}`);
} else if (cmd === 'list') {
  const rows = Object.entries(state.agents);
  if (!rows.length) console.log('no agents');
  for (const [n, a] of rows) {
    console.log(`${a.revokedAt ? 'revoked' : 'active '}  ${n}  created=${a.createdAt}${a.root ? `  root=${a.root}` : ''}`);
  }
} else if (cmd === 'revoke') {
  if (!name) fail('usage: agents.mjs revoke <name>');
  const a = state.agents[name];
  if (!a) fail(`unknown agent "${name}"`);
  a.revokedAt = new Date().toISOString();
  write(state);
  console.log(`revoked ${name}. The hub drops its socket on the next auth check; restart pi-hub.service to cut it now.`);
} else {
  console.log('usage: agents.mjs add|list|revoke <name> [--root <path>]');
  process.exit(cmd ? 1 : 0);
}
