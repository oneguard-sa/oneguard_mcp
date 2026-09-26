#!/usr/bin/env node
/**
 * The modern path: a CLI that answers `--version` and speaks `--json`.
 *
 * `smoke.test.js` drives the same server against a pre-1.3.0 CLI, so between
 * the two, both branches of every fallback are exercised. What this file is
 * specifically here to prove:
 *
 * 1. The server detects the version and switches to structured output.
 * 2. Ids come back whole, not truncated to the 8 characters the prose prints.
 * 3. **Nothing is written to disk.** The key travels in the subprocess
 *    environment, so there is no credentials file to leak or go stale.
 * 4. A refusal from the CLI arrives with its machine-readable code intact.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mock = path.join(here, 'mock-oneguard.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oneguard-mcp-json-'));
const mcpHome = path.join(tmp, 'home');
const projectDir = path.join(tmp, 'project');
fs.mkdirSync(mcpHome, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });

const child = spawn(process.execPath, [path.join(root, 'src', 'index.js')], {
  env: {
    ...process.env,
    ONEGUARD_CLI_PATH: mock,
    ONEGUARD_API_KEY: 'good-key',
    ONEGUARD_MCP_HOME: mcpHome,
    MOCK_CLI_VERSION: '1.3.0',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrLog = '';
child.stderr.on('data', (c) => {
  stderrLog += c.toString();
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
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let nextId = 1;
/** @param {string} method @param {object} [params] */
function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/** @param {string} name @param {object} [args] */
async function callTool(name, args = {}) {
  const res = await request('tools/call', { name, arguments: args });
  const text = res.result.content[0].text;
  return { isError: Boolean(res.result.isError), data: JSON.parse(text) };
}

let passed = 0;
/** @param {string} label @param {() => void} fn */
function check(label, fn) {
  fn();
  passed++;
  process.stdout.write(`  ok  ${label}\n`);
}

try {
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'structured-test', version: '0' },
  });

  // --- version detection --------------------------------------------------
  const status = await callTool('oneguard_status');
  check('the CLI version is detected and reported', () => {
    assert.equal(status.data.cli_version, '1.3.0');
    assert.equal(status.data.structured_output, true);
    assert.ok(
      !('upgrade_note' in status.data),
      'a current CLI should not be nagged about upgrading',
    );
  });

  check('status reads the structured fields, not the prose', () => {
    // The prose only ever prints a truncated org id followed by "...". Getting
    // the whole thing back is proof the JSON path was the one taken.
    assert.equal(status.data.org_id, '3f2a91bc-1111-4222-8333-444455556666');
    assert.equal(status.data.key_permission, 'write');
    assert.equal(status.data.can_write, true);
  });

  check('the CLI reports where it keeps its own credential', () => {
    assert.equal(status.data.cli_credential_storage, 'macOS Keychain');
    assert.equal(status.data.encryption.active_key_id, 'k0');
  });

  // --- nothing on disk ----------------------------------------------------
  check('no credentials file is written anywhere', () => {
    const credFile = path.join(mcpHome, '.oneguard', 'credentials.json');
    assert.ok(
      !fs.existsSync(credFile),
      `a credential was written to ${credFile}; with CLI 1.3.0 the key should only ever be in the subprocess environment`,
    );
    assert.match(
      status.data.credential_storage,
      /environment/,
      'status should say the key lives in the environment',
    );
  });

  // --- full ids -----------------------------------------------------------
  const vaults = await callTool('oneguard_vault_list');
  check('vaults come back with full ids, not 8-character stubs', () => {
    assert.equal(vaults.data.structured, true);
    assert.equal(vaults.data.count, 2);
    assert.equal(vaults.data.vaults[0].id, '0d8ac74c-1111-4222-8333-444455556666');
    assert.equal(vaults.data.vaults[0].id_prefix, '0d8ac74c');
  });

  const secrets = await callTool('oneguard_secrets_list', { vault: '0d8ac74c' });
  check('secrets come back structured, archived flag intact', () => {
    assert.equal(secrets.data.structured, true);
    assert.equal(secrets.data.count, 3);
    const legacy = secrets.data.secrets.find((s) => s.name === 'legacy');
    assert.equal(legacy.archived, true);
    assert.equal(legacy.id.length, 36);
  });

  // --- the sync flow on full ids -----------------------------------------
  const needsVault = await callTool('oneguard_env_sync', { project_dir: projectDir });
  check('an unlinked directory still asks which vault', () => {
    assert.equal(needsVault.data.status, 'needs_selection');
    assert.equal(needsVault.data.needs, 'vault');
  });

  const synced = await callTool('oneguard_env_sync', {
    project_dir: projectDir,
    vault: '0d8ac74c',
    secret: '84e1d2b3',
  });
  check('sync writes the link with the FULL secret id', () => {
    assert.equal(synced.data.status, 'synced');
    const link = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.oneguard'), 'utf8'),
    );
    assert.equal(link.secret_id, '84e1d2b3-1111-4222-8333-444455556666');
  });

  check('sync still returns names only, never values', () => {
    const raw = JSON.stringify(synced.data);
    assert.ok(!raw.includes('tok_do_not_leak'), 'no secret value in the tool result');
    assert.ok(!raw.includes('postgres://'), 'no secret value in the tool result');
    assert.deepEqual(synced.data.variables.sort(), [
      'API_TOKEN',
      'DATABASE_URL',
      'DEBUG',
    ]);
  });

  // --- structured generate ------------------------------------------------
  const genInto = await callTool('oneguard_secrets_generate', {
    vault: '0d8ac74c',
    secret: '84e1d2b3',
    key: 'NEW_TOKEN',
  });
  check('secrets_generate reads its counts from JSON, not from prose', () => {
    assert.equal(genInto.data.stored, true);
    assert.equal(genInto.data.replaced, false);
    assert.equal(genInto.data.variable_count, 4);
    assert.ok(genInto.data.variables.includes('NEW_TOKEN'));
    const raw = JSON.stringify(genInto.data);
    assert.ok(
      !/"value"\s*:/.test(raw),
      'the generated value must never appear in the result',
    );
  });

  // --- owner_count --------------------------------------------------------
  const members = await callTool('oneguard_teams_list');
  check('teams_list surfaces how many owners are left', () => {
    assert.equal(members.data.owner_count, 1);
    assert.equal(members.data.members[0].id.length, 36);
  });

  // --- last-owner refusal round-trips with its code -----------------------
  const lastOwner = await callTool('oneguard_teams_remove', {
    member: 'mohmad@oneguard.one',
    confirm: 'mohmad@oneguard.one',
  });
  check('removing the last owner is refused, with the reason intact', () => {
    assert.equal(lastOwner.isError, true);
    assert.match(lastOwner.data.error, /only owner/i);
  });

  const demoteOwner = await callTool('oneguard_teams_set_role', {
    member: 'mohmad@oneguard.one',
    role: 'member',
  });
  check('demoting the last owner is refused too', () => {
    assert.equal(demoteOwner.isError, true);
    assert.match(demoteOwner.data.error, /only owner/i);
  });

  // --- logs ---------------------------------------------------------------
  const logs = await callTool('oneguard_logs_list', { limit: 5 });
  check('audit entries arrive as ISO timestamps', () => {
    assert.equal(logs.data.count, 2);
    assert.ok(!Number.isNaN(Date.parse(logs.data.entries[0].time)));
  });

  process.stdout.write(`\n# ${passed} checks passed\n`);
} catch (error) {
  process.stdout.write(`\n# FAILED after ${passed} checks\n`);
  process.stderr.write(`${error?.stack || error}\n`);
  if (stderrLog) process.stderr.write(`\n--- server stderr ---\n${stderrLog}\n`);
  child.kill();
  process.exit(1);
}

child.kill();
fs.rmSync(tmp, { recursive: true, force: true });
