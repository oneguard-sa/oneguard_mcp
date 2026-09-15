#!/usr/bin/env node
/**
 * Live check against the real backend.
 *
 * Boots the server exactly the way a client would, then walks the read-only
 * path: status -> projects -> secrets of the first project. Prints what came
 * back so you can see whether the key works, whether the CLI is found, and
 * whether the output parsers still match the CLI's formatting.
 *
 *   ONEGUARD_API_KEY=og_xxx node test/live-check.js
 *   ONEGUARD_API_KEY=og_xxx ONEGUARD_CLI_PATH=/path/to/oneguard node test/live-check.js
 *
 * Read-only: it never writes, deletes, or syncs anything.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '..', 'src', 'index.js');

if (!process.env.ONEGUARD_API_KEY) {
  process.stderr.write(
    'Set ONEGUARD_API_KEY first:\n  ONEGUARD_API_KEY=og_xxx node test/live-check.js\n',
  );
  process.exit(1);
}

const child = spawn(process.execPath, [entry], {
  env: { ...process.env, ONEGUARD_MCP_READONLY: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
});

/** @type {Map<number, (v:any)=>void>} */
const pending = new Map();
let buf = '';
child.stdout.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});

let id = 1;
/** @param {string} method @param {object} [params] */
function request(method, params = {}) {
  const rid = id++;
  return new Promise((resolve) => {
    pending.set(rid, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`);
  });
}

/** @param {string} name @param {object} [args] */
async function call(name, args = {}) {
  const res = await request('tools/call', { name, arguments: args });
  return {
    isError: Boolean(res.result?.isError),
    data: JSON.parse(res.result.content[0].text),
  };
}

/** @param {string} s */
const say = (s) => process.stdout.write(`${s}\n`);

const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'live-check', version: '0' },
});
say(`handshake ok — protocol ${init.result.protocolVersion}\n`);

const status = await call('oneguard_status');
if (status.isError) {
  say(`FAILED at status: ${status.data.error}`);
  child.kill();
  process.exit(1);
}
say(`connected — org ${status.data.org_id}`);
say(`  cli:  ${status.data.cli_path}`);
say(`  home: ${status.data.config_home}\n`);

const vaults = await call('oneguard_vault_list');
if (vaults.isError) {
  say(`FAILED at vaults: ${vaults.data.error}`);
  child.kill();
  process.exit(1);
}
say(`vaults (${vaults.data.count}):`);
for (const v of vaults.data.vaults) say(`  ${v.id}  ${v.name}`);

if (vaults.data.count === 0) {
  say('\nNo vaults yet — nothing more to check.');
} else {
  const first = vaults.data.vaults[0];
  say(`\nsecrets in "${first.name}":`);
  const secrets = await call('oneguard_secrets_list', { vault: first.id });
  if (secrets.isError) {
    say(`  FAILED: ${secrets.data.error}`);
  } else if (secrets.data.count === 0) {
    say('  (none)');
  } else {
    for (const s of secrets.data.secrets) {
      say(`  ${s.id}  ${s.name}${s.archived ? '  [archived]' : ''}`);
    }
  }
}

// A parser mismatch shows up as "the CLI printed lines but we parsed zero rows".
if (vaults.data.count === 0 && vaults.data.raw.includes('ID:')) {
  say('\nWARNING: the CLI printed vault lines but the parser matched none.');
  say('The output format changed — update src/parsers.js.');
}

say('\nAll read-only checks passed.');
child.kill();
process.exit(0);
