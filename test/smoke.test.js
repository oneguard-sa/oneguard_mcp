#!/usr/bin/env node
/**
 * End-to-end smoke test: drives the server over real stdio JSON-RPC with a
 * mock CLI, and asserts the protocol handshake, the tool listing, the sync
 * flow, and the guardrails.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oneguard-mcp-'));
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
/**
 * @param {string} method
 * @param {object} [params]
 */
function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/**
 * @param {string} name
 * @param {object} [args]
 */
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
  // --- handshake ---------------------------------------------------------
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0' },
  });
  check('initialize negotiates the protocol', () => {
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'oneguard');
    assert.ok(init.result.capabilities.tools);
  });

  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  );

  const listed = await request('tools/list');
  const names = listed.result.tools.map((/** @type {any} */ t) => t.name);
  check('tools/list advertises the full toolset', () => {
    assert.ok(names.includes('oneguard_env_sync'));
    assert.ok(names.includes('oneguard_secrets_delete'));
    assert.ok(names.includes('oneguard_vault_list'));
    assert.ok(names.includes('oneguard_secrets_generate'));
    assert.ok(!names.some((/** @type {string} */ n) => n.startsWith('oneguard_projects_')));
    assert.equal(names.length, 21);
    for (const t of listed.result.tools) {
      assert.equal(t.inputSchema.type, 'object', `${t.name} has an object schema`);
      assert.ok(t.description.length > 40, `${t.name} has a real description`);
    }
  });

  // --- auto-init from the env var ---------------------------------------
  const status = await callTool('oneguard_status');
  check('status auto-initializes from ONEGUARD_API_KEY', () => {
    assert.equal(status.isError, false);
    assert.equal(status.data.ok, true);
    assert.equal(status.data.org_id, '3f2a91bc');
  });
  check('status reports the key permission', () => {
    assert.equal(status.data.key_permission, 'write');
    assert.equal(status.data.can_write, true);
  });
  check('credentials landed in the isolated home, not the real one', () => {
    assert.ok(fs.existsSync(path.join(mcpHome, '.oneguard', 'credentials.json')));
    assert.ok(!stderrLog.includes('good-key'), 'the key is never logged');
  });

  // --- the sync flow -----------------------------------------------------
  const needsProject = await callTool('oneguard_env_sync', { project_dir: projectDir });
  check('sync on an unlinked directory asks which vault', () => {
    assert.equal(needsProject.data.status, 'needs_selection');
    assert.equal(needsProject.data.needs, 'vault');
    assert.equal(needsProject.data.vaults.length, 2);
    assert.equal(needsProject.data.vaults[0].name, 'oneguard-api');
  });

  const needsSecret = await callTool('oneguard_env_sync', {
    project_dir: projectDir,
    vault: '0d8ac74c',
  });
  check('sync then asks which secret, hiding archived ones', () => {
    assert.equal(needsSecret.data.needs, 'secret');
    assert.equal(needsSecret.data.secrets.length, 2);
    assert.ok(!needsSecret.data.secrets.some((/** @type {any} */ s) => s.archived));
  });

  const synced = await callTool('oneguard_env_sync', {
    project_dir: projectDir,
    vault: '0d8ac74c',
    secret: '84e1d2b3',
  });
  check('sync writes the .env and returns names only', () => {
    assert.equal(synced.data.status, 'synced');
    assert.deepEqual(synced.data.variables, ['DATABASE_URL', 'API_TOKEN', 'DEBUG']);
    assert.equal(synced.data.secret.name, 'production');
    const raw = JSON.stringify(synced.data);
    assert.ok(!raw.includes('tok_do_not_leak'), 'no secret value in the tool result');
    assert.ok(!raw.includes('postgres://'), 'no secret value in the tool result');
  });
  check('the .env file itself has the real values on disk', () => {
    const envText = fs.readFileSync(path.join(projectDir, '.env'), 'utf8');
    assert.ok(envText.includes('tok_do_not_leak'));
  });
  check('the link file is the same shape the CLI writes', () => {
    const link = JSON.parse(fs.readFileSync(path.join(projectDir, '.oneguard'), 'utf8'));
    assert.equal(link.project_id, '0d8ac74c');
    assert.equal(link.secret_id, '84e1d2b3');
  });

  const relinked = await callTool('oneguard_env_sync', { project_dir: projectDir });
  check('a linked directory re-syncs with no arguments', () => {
    assert.equal(relinked.data.status, 'synced');
    assert.equal(relinked.data.secret.id, '84e1d2b3');
  });

  const envStatus = await callTool('oneguard_env_status', { project_dir: projectDir });
  check('env_status reports the link and the variable names', () => {
    assert.equal(envStatus.data.linked, true);
    assert.equal(envStatus.data.secret_name, 'production');
    assert.equal(envStatus.data.variables.length, 3);
  });

  const pushed = await callTool('oneguard_env_push', { project_dir: projectDir });
  check('push uploads the local file back to the linked secret', () => {
    assert.equal(pushed.data.status, 'pushed');
    assert.equal(pushed.data.payload_replaced, true);
    assert.equal(pushed.data.variable_count, 3);
  });

  // --- generation --------------------------------------------------------
  const gen = await callTool('oneguard_generate', { length: 24, count: 3 });
  check('generate returns values locally, no auth needed', () => {
    assert.equal(gen.isError, false);
    assert.equal(gen.data.count, 3);
    assert.equal(gen.data.values[0].length, 24);
  });

  const badCharset = await callTool('oneguard_generate', {
    lowercase: false,
    uppercase: false,
    numbers: false,
    special: false,
  });
  check('generate refuses an empty character set', () => {
    assert.equal(badCharset.isError, true);
  });

  const genInto = await callTool('oneguard_secrets_generate', {
    vault: '0d8ac74c',
    secret: '84e1d2b3',
    key: 'DB_PASSWORD',
    length: 32,
  });
  check('secrets_generate stores without returning the value', () => {
    assert.equal(genInto.isError, false);
    assert.equal(genInto.data.stored, true);
    assert.equal(genInto.data.key, 'DB_PASSWORD');
    assert.equal(genInto.data.variable_count, 4);
    assert.equal(genInto.data.replaced, false);
    const raw = JSON.stringify(genInto.data);
    assert.ok(!/value["']?\s*:\s*["'][^"']{8,}/.test(raw), 'no value field in the result');
  });

  const collide = await callTool('oneguard_secrets_generate', {
    vault: '0d8ac74c',
    secret: '84e1d2b3',
    key: 'EXISTING',
  });
  check('secrets_generate refuses to clobber an existing key', () => {
    assert.equal(collide.isError, true);
    assert.match(collide.data.error, /already exists/);
  });

  const forced = await callTool('oneguard_secrets_generate', {
    vault: '0d8ac74c',
    secret: '84e1d2b3',
    key: 'EXISTING',
    force: true,
  });
  check('secrets_generate replaces when force is set', () => {
    assert.equal(forced.isError, false);
    assert.equal(forced.data.replaced, true);
  });

  // --- team management ---------------------------------------------------
  const roleChanged = await callTool('oneguard_teams_set_role', {
    member: 'dev@oneguard.one',
    role: 'admin',
  });
  check('set_role resolves the member and reports the change', () => {
    assert.equal(roleChanged.isError, false);
    assert.equal(roleChanged.data.member.email, 'dev@oneguard.one');
    assert.equal(roleChanged.data.previous_role, 'member');
    assert.equal(roleChanged.data.new_role, 'admin');
  });

  const noop = await callTool('oneguard_teams_set_role', {
    member: '12ab34cd',
    role: 'owner',
  });
  check('set_role is a no-op when the role already matches', () => {
    assert.equal(noop.data.updated, false);
    assert.match(noop.data.note, /already has the role/);
  });

  const unknownMember = await callTool('oneguard_teams_set_role', {
    member: 'nobody@example.com',
    role: 'member',
  });
  check('set_role refuses an unknown member', () => {
    assert.equal(unknownMember.isError, true);
    assert.match(unknownMember.data.error, /No member matching/);
  });

  const serverRefusal = await callTool('oneguard_teams_set_role', {
    member: 'dev@oneguard.one',
    role: 'owner',
  });
  check('a server-side permission refusal surfaces as a tool error', () => {
    assert.equal(serverRefusal.isError, true);
    assert.match(serverRefusal.data.error, /cannot promote/i);
  });

  const wrongConfirm = await callTool('oneguard_teams_remove', {
    member: 'dev@oneguard.one',
    confirm: 'mohmad@oneguard.one',
  });
  check('remove refuses when the confirmation email does not match', () => {
    assert.equal(wrongConfirm.isError, true);
    assert.match(wrongConfirm.data.error, /Refusing to remove/);
  });

  const removed = await callTool('oneguard_teams_remove', {
    member: 'dev@oneguard.one',
    confirm: 'dev@oneguard.one',
  });
  check('remove proceeds when the email matches', () => {
    assert.equal(removed.isError, false);
    assert.equal(removed.data.member.email, 'dev@oneguard.one');
  });

  // --- guardrails --------------------------------------------------------
  const badDir = await callTool('oneguard_env_sync', { project_dir: './relative' });
  check('a relative project_dir is refused', () => {
    assert.equal(badDir.isError, true);
    assert.match(badDir.data.error, /absolute path/);
  });

  const escape = await callTool('oneguard_env_status', {
    project_dir: projectDir,
    path: '../../etc/passwd',
  });
  check('an env path escaping project_dir is refused', () => {
    assert.equal(escape.isError, true);
    assert.match(escape.data.error, /stay inside project_dir/);
  });

  const wrongName = await callTool('oneguard_secrets_delete', {
    vault: '0d8ac74c',
    secret: '84e1d2b3',
    confirm: 'staging',
  });
  check('delete refuses when the confirmation name does not match', () => {
    assert.equal(wrongName.isError, true);
    assert.match(wrongName.data.error, /Refusing to delete/);
  });

  const rightName = await callTool('oneguard_secrets_delete', {
    vault: '0d8ac74c',
    secret: '84e1d2b3',
    confirm: 'production',
  });
  check('delete proceeds when the name matches', () => {
    assert.equal(rightName.isError, false);
    assert.equal(rightName.data.deleted, true);
  });

  const badEmail = await callTool('oneguard_teams_invite', { email: 'not-an-email' });
  check('invite validates the address before spending a CLI call', () => {
    assert.equal(badEmail.isError, true);
  });

  const unknown = await request('tools/call', { name: 'oneguard_nope', arguments: {} });
  check('an unknown tool is a protocol error, not a crash', () => {
    assert.equal(unknown.error.code, -32602);
  });

  const badMethod = await request('resources/list');
  check('an unsupported method returns -32601 and the server stays up', () => {
    assert.equal(badMethod.error.code, -32601);
  });

  const stillAlive = await request('ping');
  check('server still responds after errors', () => {
    assert.deepEqual(stillAlive.result, {});
  });

  // --- recovery from a revoked key --------------------------------------
  fs.rmSync(path.join(mcpHome, '.oneguard', 'credentials.json'));
  const recovered = await callTool('oneguard_vault_list');
  check('a wiped credential file re-initializes from the env var', () => {
    assert.equal(recovered.isError, false);
    assert.equal(recovered.data.count, 2);
    assert.equal(recovered.data.vaults[0].name, 'oneguard-api');
  });

  // --- a read-only API key ----------------------------------------------
  // The server refuses writes for a key created with `read` permission. The
  // CLI reports that as a 403, which must NOT be mistaken for a dead session.
  const roKeyHome = path.join(tmp, 'rokey-home');
  fs.mkdirSync(roKeyHome, { recursive: true });
  const roKey = spawn(process.execPath, [path.join(root, 'src', 'index.js')], {
    env: {
      ...process.env,
      ONEGUARD_CLI_PATH: mock,
      ONEGUARD_API_KEY: 'good-key',
      ONEGUARD_MCP_HOME: roKeyHome,
      MOCK_PERMISSION: 'read',
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  /** @type {Map<number, (v:any)=>void>} */
  const roPending = new Map();
  let roBuf = '';
  roKey.stdout.on('data', (c) => {
    roBuf += c.toString();
    let i;
    while ((i = roBuf.indexOf('\n')) !== -1) {
      const line = roBuf.slice(0, i).trim();
      roBuf = roBuf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      roPending.get(msg.id)?.(msg);
      roPending.delete(msg.id);
    }
  });
  let roId = 1;
  /** @param {string} name @param {object} [args] */
  const roCall = (name, args = {}) =>
    new Promise((resolve) => {
      const id = roId++;
      roPending.set(id, (/** @type {any} */ res) =>
        resolve({
          isError: Boolean(res.result?.isError),
          data: JSON.parse(res.result.content[0].text),
        }),
      );
      roKey.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`,
      );
    });

  const roStatus = /** @type {any} */ (await roCall('oneguard_status'));
  check('a read-only key is reported as read-only before anything is tried', () => {
    assert.equal(roStatus.isError, false);
    assert.equal(roStatus.data.key_permission, 'read');
    assert.equal(roStatus.data.can_write, false);
    assert.match(roStatus.data.note, /read-only/);
  });

  const roRead = /** @type {any} */ (
    await roCall('oneguard_secrets_list', { vault: '0d8ac74c' })
  );
  check('a read-only key can still read', () => {
    assert.equal(roRead.isError, false);
    assert.equal(roRead.data.count, 3);
  });

  const roWrite = /** @type {any} */ (
    await roCall('oneguard_vault_add', { name: 'should-be-refused' })
  );
  check('a read-only key is refused on a write', () => {
    assert.equal(roWrite.isError, true);
    assert.match(roWrite.data.error, /read-only/);
  });

  check('the refusal does NOT wipe the stored credentials', () => {
    // The bug this guards: a 403 handled as a 401 would clear the key here and
    // send the user off to re-authenticate, which fixes nothing.
    assert.ok(fs.existsSync(path.join(roKeyHome, '.oneguard', 'credentials.json')));
  });

  const roStillWorks = /** @type {any} */ (await roCall('oneguard_vault_list'));
  check('the session survives the refusal', () => {
    assert.equal(roStillWorks.isError, false);
    assert.equal(roStillWorks.data.count, 2);
  });
  roKey.kill();

  // --- read-only mode ----------------------------------------------------
  const ro = spawn(process.execPath, [path.join(root, 'src', 'index.js')], {
    env: {
      ...process.env,
      ONEGUARD_CLI_PATH: mock,
      ONEGUARD_API_KEY: 'good-key',
      ONEGUARD_MCP_HOME: mcpHome,
      ONEGUARD_MCP_READONLY: '1',
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const roTools = await new Promise((resolve) => {
    let b = '';
    ro.stdout.on('data', (c) => {
      b += c.toString();
      const i = b.indexOf('\n');
      if (i === -1) return;
      resolve(JSON.parse(b.slice(0, i)).result.tools.map((/** @type {any} */ t) => t.name));
    });
    ro.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`,
    );
  });
  check('read-only mode hides every mutating tool', () => {
    assert.ok(!roTools.includes('oneguard_secrets_delete'));
    assert.ok(!roTools.includes('oneguard_env_push'));
    assert.ok(!roTools.includes('oneguard_env_sync'));
    assert.ok(!roTools.includes('oneguard_secrets_generate'));
    assert.ok(!roTools.includes('oneguard_teams_remove'));
    assert.ok(!roTools.includes('oneguard_teams_set_role'));
    assert.ok(roTools.includes('oneguard_secrets_list'));
    assert.ok(roTools.includes('oneguard_generate'), 'local generation stays available');
    assert.ok(roTools.includes('oneguard_env_status'));
  });
  ro.kill();

  process.stdout.write(`\n${passed} checks passed\n`);
  child.kill();
  process.exit(0);
} catch (e) {
  process.stdout.write(`\nFAILED: ${e?.message}\n`);
  process.stdout.write(`\n--- server stderr ---\n${stderrLog}\n`);
  child.kill();
  process.exit(1);
}
