#!/usr/bin/env node
/**
 * A stand-in for the real `oneguard` binary, reproducing its exact stdout
 * formatting, exit codes and credential behaviour. Lets the server be tested
 * end to end without a network or a real organization.
 *
 * ## Two CLIs in one
 *
 * `MOCK_CLI_VERSION` decides which `oneguard` this pretends to be:
 *
 * * unset — a pre-1.3.0 CLI. `--version` is not a command, there is no
 *   `--json`, and the key has to be stored by `auth login`. This is the
 *   default so the main suite keeps testing the fallback path, which is what
 *   real users with an older binary will be on.
 * * a version string (e.g. `1.3.0`) — the current CLI: answers `--version`,
 *   speaks `--json`, and reads its key from `ONEGUARD_API_KEY` with nothing
 *   written to disk.
 *
 * Keeping both means the server's compatibility with an older CLI is a tested
 * claim rather than an intention.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE || '';
const credFile = path.join(home, '.oneguard', 'credentials.json');

const VALID_KEY = 'good-key';

/** Which CLI this invocation is pretending to be. */
const CLI_VERSION = process.env.MOCK_CLI_VERSION || '';
const MODERN = CLI_VERSION !== '';

// Simulates the permission stamped on the API key, so the read-only refusal
// path can be tested end to end.
const PERMISSION = process.env.MOCK_PERMISSION === 'read' ? 'read' : 'write';

// `--json` is a global flag and comes before the command, exactly as in the
// real CLI. An old CLI has never heard of it.
let json = false;
if (MODERN) {
  const i = argv.indexOf('--json');
  if (i >= 0) {
    json = true;
    argv.splice(i, 1);
  }
}

/** Prose. Suppressed under --json, exactly as CliOutput does. */
const out = (s) => {
  if (json) return;
  process.stdout.write(`${s}\n`);
};

/** @param {string} s */
const err = (s) => process.stderr.write(`${s}\n`);

/** The one structured object a command emits. Does nothing without --json. */
let emitted = false;
/** @param {Record<string, unknown>} payload */
function data(payload) {
  if (!json || emitted) return;
  emitted = true;
  process.stdout.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
}

/**
 * Fails the way the real CLI does: prose on stderr always, the structured form
 * on stdout under --json, exit 1.
 *
 * @param {string} message
 * @param {string} code
 */
function fail(message, code = 'unexpected') {
  err(message);
  if (json && !emitted) {
    emitted = true;
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { type: code, code, message } })}\n`,
    );
  }
  process.exit(1);
}

/** @param {string} name */
function opt(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Full ids, truncated for the prose exactly as the real CLI truncates them. */
const VAULTS = [
  { id: '0d8ac74c-1111-4222-8333-444455556666', name: 'oneguard-api' },
  { id: 'aabbccdd-1111-4222-8333-444455556666', name: 'marketing-site' },
];
const SECRETS = {
  default: [
    { id: '84e1d2b3-1111-4222-8333-444455556666', name: 'production', archived: false },
    { id: '55667788-1111-4222-8333-444455556666', name: 'staging', archived: false },
    { id: '99aabbcc-1111-4222-8333-444455556666', name: 'legacy', archived: true },
  ],
  aabbccdd: [
    { id: '11112222-1111-4222-8333-444455556666', name: 'web-prod', archived: false },
  ],
};
const MEMBERS = [
  { id: '12ab34cd-1111-4222-8333-444455556666', email: 'mohmad@oneguard.one', role: 'owner' },
  { id: '56ef78ab-1111-4222-8333-444455556666', email: 'dev@oneguard.one', role: 'member' },
];

/** @param {string} id */
const prefixOf = (id) => (id.length > 8 ? id.slice(0, 8) : id);

function loggedIn() {
  // The modern CLI takes its key from the environment and stores nothing.
  if (MODERN && (process.env.ONEGUARD_API_KEY || '').length > 0) return true;
  try {
    return Boolean(JSON.parse(fs.readFileSync(credFile, 'utf8')).api_key);
  } catch {
    return false;
  }
}

/**
 * The real CLI turns the server's 403 into a ForbiddenError: the message is
 * printed to stderr, the exit code is 1, and — crucially — the stored key is
 * NOT cleared and no "auth login" hint is printed. Reproduced exactly here.
 */
function requireWrite() {
  requireAuth();
  if (PERMISSION !== 'write') {
    fail(
      'This API key is read-only. Create a key with write permission in the OneGuard dashboard to perform this action.',
      'forbidden',
    );
  }
}

function requireAuth() {
  if (loggedIn()) return;
  err('You are not authorized. Please log in.');
  err("Run 'oneguard auth login <API_KEY>' to sign in again.");
  if (json && !emitted) {
    emitted = true;
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: {
          type: 'UnauthorizedError',
          code: 'unauthenticated',
          message: 'Not authenticated.',
        },
      })}\n`,
    );
  }
  process.exit(1);
}

// --version is answered before dispatch, as a flag rather than a command.
if (argv.includes('--version') || argv[0] === 'version') {
  if (!MODERN) {
    err('Could not find a command named "--version".');
    process.exit(64);
  }
  out(`oneguard ${CLI_VERSION}`);
  data({ version: CLI_VERSION });
  process.exit(0);
}

const [group, sub] = argv;

if (group === 'auth' && sub === 'login') {
  const key = argv[2];
  if (key !== VALID_KEY) {
    fail('Invalid API key.', 'unauthenticated');
  }
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, JSON.stringify({ api_key: key }));
  out('Verifying API Key...');
  out('Login successful! API Key stored securely.');
  data({ authenticated: true, credential_storage: 'plain file (not encrypted)' });
  process.exit(0);
}

if (group === 'status') {
  requireAuth();
  out('Checking OneGuard CLI status...');
  out('API Key is configured.');
  out('Verifying connection to backend...');
  out('Backend is reachable.');
  out('API Key is valid (Org ID: 3f2a91bc...).');
  out(`Permission: ${PERMISSION} (${PERMISSION === 'write' ? 'read and write' : 'read only'}).`);
  data({
    version: CLI_VERSION,
    authenticated: true,
    backend_reachable: true,
    valid: true,
    org_id: '3f2a91bc-1111-4222-8333-444455556666',
    key_permission: PERMISSION,
    can_write: PERMISSION === 'write',
    credential_storage: 'macOS Keychain',
    encryption: {
      active_key_id: 'k0',
      writes_envelope: false,
      known_key_ids: ['k0'],
    },
  });
  process.exit(0);
}

if ((group === 'vault' || group === 'projects') && sub === 'list') {
  requireAuth();
  out('Your vaults:');
  out('');
  for (const v of VAULTS) out(`ID: ${prefixOf(v.id)} | Name: ${v.name}`);
  data({
    vaults: VAULTS.map((v) => ({ id: v.id, id_prefix: prefixOf(v.id), name: v.name })),
    count: VAULTS.length,
  });
  process.exit(0);
}

if ((group === 'vault' || group === 'projects') && sub === 'add') {
  requireWrite();
  const id = '99887766-1111-2222-3333-444455556666';
  out(`Vault created successfully with ID: ${id}`);
  data({
    created: true,
    vault: { id, id_prefix: prefixOf(id), name: opt('name') },
  });
  process.exit(0);
}

if (group === 'secrets' && sub === 'list') {
  requireAuth();
  const project = opt('project') || '';
  const rows = project.startsWith('aabbccdd') ? SECRETS.aabbccdd : SECRETS.default;
  for (const s of rows) {
    out(`ID: ${prefixOf(s.id)} | Name: ${s.name} | Archived: ${s.archived}`);
  }
  data({
    vault: project,
    secrets: rows.map((s) => ({
      id: s.id,
      id_prefix: prefixOf(s.id),
      name: s.name,
      archived: s.archived,
    })),
    count: rows.length,
  });
  process.exit(0);
}

if (group === 'generate') {
  // Local only: no auth, no network.
  const len = Number(opt('length') ?? 16);
  const count = Number(opt('count') ?? 1);
  if (argv.includes('--no-lowercase') && argv.includes('--no-uppercase') &&
      argv.includes('--no-numbers') && argv.includes('--no-special')) {
    fail('At least one character set must be enabled.', 'invalid_input');
  }
  const values = Array.from({ length: count }, () =>
    Array.from({ length: len }, () => 'aB3!'[Math.floor(Math.random() * 4)]).join(''),
  );
  for (const v of values) out(v);
  data({ values, count: values.length });
  process.exit(0);
}

if (group === 'secrets' && sub === 'generate') {
  requireWrite();
  const key = opt('key');
  if (key === 'EXISTING' && !argv.includes('--force')) {
    fail(
      `"${key}" already exists in secret "production". Pass --force to replace its value.`,
      'invalid_input',
    );
  }
  const replaced = key === 'EXISTING';
  const variables = replaced
    ? ['DATABASE_URL', 'EXISTING', 'REGION']
    : ['DATABASE_URL', 'REGION', 'TIMEOUT', String(key)];
  out(`${replaced ? 'Replaced' : 'Added'} "${key}" in secret "production" (${variables.length} variables total).`);
  out("Value not shown. Run 'oneguard env pull ...' to write it to a file.");
  data({
    key,
    replaced,
    vault: opt('project'),
    secret: { id_or_prefix: opt('id'), name: 'production' },
    variables: [...variables].sort(),
    variable_count: variables.length,
  });
  process.exit(0);
}

if (group === 'secrets' && sub === 'edit') {
  requireWrite();
  const file = opt('file');
  if (file && !fs.existsSync(file)) {
    fail(`File not found: ${file}`, 'invalid_input');
  }
  out('Secret updated successfully.');
  data({
    updated: true,
    vault: opt('project'),
    secret: { id_or_prefix: opt('id'), name: opt('name') },
    payload_replaced: true,
  });
  process.exit(0);
}

if (group === 'secrets' && sub === 'delete') {
  requireWrite();
  out('Secret deleted successfully.');
  data({
    deleted: true,
    vault: opt('project'),
    secret: { id_or_prefix: opt('id') },
  });
  process.exit(0);
}

if (group === 'env' && sub === 'sync' && argv.includes('--push')) {
  requireWrite();
  const target = opt('path') || '.env';
  if (!fs.existsSync(target)) {
    fail(`File not found: ${target}`, 'invalid_input');
  }
  const names = fs
    .readFileSync(target, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && l.includes('='))
    .map((l) => l.slice(0, l.indexOf('=')).trim());
  if (names.length === 0) {
    fail(
      `${target} contains no variables. Refusing to overwrite the remote secret with an empty payload.`,
      'invalid_input',
    );
  }
  out(`Pushed ${names.length} variables from ${target} into secret "production".`);
  data({
    direction: 'push',
    path: target,
    secret: { name: 'production' },
    variables: [...names].sort(),
    variable_count: names.length,
  });
  process.exit(0);
}

if (group === 'env' && sub === 'pull') {
  requireAuth();
  const target = opt('path') || '.env';
  fs.writeFileSync(
    target,
    'DATABASE_URL=postgres://secret-value-here\nAPI_TOKEN=tok_do_not_leak\nDEBUG=false\n',
  );
  out(`Successfully pulled environment variables into ${target}`);
  data({
    direction: 'pull',
    path: target,
    secret: { id_or_prefix: opt('id') },
    // Names only. A value here would end up in an agent transcript.
    variables: ['API_TOKEN', 'DATABASE_URL', 'DEBUG'],
    variable_count: 3,
    key_id: 'k0',
  });
  process.exit(0);
}

if (group === 'teams' && sub === 'list') {
  requireAuth();
  for (const m of MEMBERS) {
    out(`ID: ${prefixOf(m.id)} | Email: ${m.email} | Role: ${m.role}`);
  }
  data({
    members: MEMBERS.map((m) => ({
      id: m.id,
      id_prefix: prefixOf(m.id),
      email: m.email,
      role: m.role,
    })),
    count: MEMBERS.length,
    owner_count: MEMBERS.filter((m) => m.role === 'owner').length,
  });
  process.exit(0);
}

if (group === 'teams' && sub === 'role') {
  requireWrite();
  const member = opt('member');
  const role = opt('role');
  if (member === 'dev@oneguard.one' && role === 'owner') {
    fail('Admins cannot promote users to Admin or Owner', 'bad_request');
  }
  if (member === 'mohmad@oneguard.one' && role !== 'owner') {
    fail(
      'This is the only owner of the organization. Changing their role would leave nobody able to manage it. Promote another member to owner first.',
      'bad_request',
    );
  }
  out(`Role updated: ${member} is now ${role}.`);
  data({ updated: true, member: { email: member, role } });
  process.exit(0);
}

if (group === 'teams' && sub === 'remove') {
  requireWrite();
  const member = opt('member');
  if (!argv.includes('--yes')) {
    fail(
      `This removes "${member}" from the organization and revokes their access. Re-run with --yes to confirm.`,
      'invalid_input',
    );
  }
  if (member === 'mohmad@oneguard.one') {
    fail(
      'This is the only owner of the organization. Removing them would leave nobody able to manage it. Promote another member to owner first.',
      'bad_request',
    );
  }
  out(`Removed ${member} from the organization.`);
  data({ removed: true, member });
  process.exit(0);
}

if (group === 'teams' && sub === 'invite') {
  requireWrite();
  const email = opt('email');
  out(`Invitation sent successfully to ${email}.`);
  data({
    invited: true,
    email,
    role: opt('role') || 'member',
    invitation_id: 'aa112233-1111-4222-8333-444455556666',
  });
  process.exit(0);
}

if (group === 'logs' && sub === 'list') {
  requireAuth();
  const entries = [
    { time: '2026-09-06T10:00:00.000Z', action: 'create', user: 'Mohmad', resource: 'project/oneguard-api' },
    { time: '2026-09-06T10:05:00.000Z', action: 'update', user: 'Dev', resource: 'secret/production' },
  ];
  out('[2026-09-06 10:00:00.000] [create] Mohmad: project/oneguard-api');
  out('[2026-09-06 10:05:00.000] [update] Dev: secret/production');
  data({ entries, count: entries.length });
  process.exit(0);
}

err(`Could not find a command named "${argv.join(' ')}".`);
process.exit(64);
