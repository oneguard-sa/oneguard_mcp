#!/usr/bin/env node
/**
 * A stand-in for the real `oneguard` binary, reproducing its exact stdout
 * formatting, exit codes and credential behaviour. Lets the server be tested
 * end to end without a network or a real organization.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const home = process.env.HOME || process.env.USERPROFILE || '';
const credFile = path.join(home, '.oneguard', 'credentials.json');

const VALID_KEY = 'good-key';

// Simulates the permission stamped on the API key, so the read-only refusal
// path can be tested end to end.
const PERMISSION = process.env.MOCK_PERMISSION === 'read' ? 'read' : 'write';

/** @param {string} s */
const out = (s) => process.stdout.write(`${s}\n`);
/** @param {string} s */
const err = (s) => process.stderr.write(`${s}\n`);

/** @param {string} name */
function opt(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function loggedIn() {
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
    err(
      'This API key is read-only. Create a key with write permission in the OneGuard dashboard to perform this action.',
    );
    process.exit(1);
  }
}

function requireAuth() {
  if (loggedIn()) return;
  err('You are not authorized. Please log in.');
  err("Run 'oneguard auth login <API_KEY>' to sign in again.");
  process.exit(1);
}

const [group, sub] = argv;

if (group === 'auth' && sub === 'login') {
  const key = argv[2];
  if (key !== VALID_KEY) {
    err('Invalid API key.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, JSON.stringify({ api_key: key }));
  out('Verifying API Key...');
  out('Login successful! API Key stored securely.');
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
  process.exit(0);
}

if ((group === 'vault' || group === 'projects') && sub === 'list') {
  requireAuth();
  out('Your vaults:');
  out('');
  out('ID: 0d8ac74c | Name: oneguard-api');
  out('ID: aabbccdd | Name: marketing-site');
  process.exit(0);
}

if ((group === 'vault' || group === 'projects') && sub === 'add') {
  requireWrite();
  out('Vault created successfully with ID: 99887766-1111-2222-3333-444455556666');
  process.exit(0);
}

if (group === 'secrets' && sub === 'list') {
  requireAuth();
  const project = opt('project');
  if (project === 'aabbccdd') {
    out('ID: 11112222 | Name: web-prod | Archived: false');
    process.exit(0);
  }
  out('ID: 84e1d2b3 | Name: production | Archived: false');
  out('ID: 55667788 | Name: staging | Archived: false');
  out('ID: 99aabbcc | Name: legacy | Archived: true');
  process.exit(0);
}

if (group === 'generate') {
  // Local only: no auth, no network.
  const len = Number(opt('length') ?? 16);
  const count = Number(opt('count') ?? 1);
  if (argv.includes('--no-lowercase') && argv.includes('--no-uppercase') &&
      argv.includes('--no-numbers') && argv.includes('--no-special')) {
    err('At least one character set must be enabled.');
    process.exit(1);
  }
  for (let i = 0; i < count; i++) {
    out(Array.from({ length: len }, () => 'aB3!'[Math.floor(Math.random() * 4)]).join(''));
  }
  process.exit(0);
}

if (group === 'secrets' && sub === 'generate') {
  requireWrite();
  const key = opt('key');
  if (key === 'EXISTING' && !argv.includes('--force')) {
    err(`"${key}" already exists in secret "production". Pass --force to replace its value.`);
    process.exit(1);
  }
  const replaced = key === 'EXISTING';
  out(`${replaced ? 'Replaced' : 'Added'} "${key}" in secret "production" (${replaced ? 3 : 4} variables total).`);
  out("Value not shown. Run 'oneguard env pull ...' to write it to a file.");
  process.exit(0);
}

if (group === 'secrets' && sub === 'edit') {
  requireWrite();
  const file = opt('file');
  if (file && !fs.existsSync(file)) {
    err(`File not found: ${file}`);
    process.exit(1);
  }
  out('Secret updated successfully.');
  process.exit(0);
}

if (group === 'secrets' && sub === 'delete') {
  requireWrite();
  out('Secret deleted successfully.');
  process.exit(0);
}

if (group === 'env' && sub === 'sync' && argv.includes('--push')) {
  requireWrite();
  const target = opt('path') || '.env';
  if (!fs.existsSync(target)) {
    err(`File not found: ${target}`);
    process.exit(1);
  }
  const count = fs
    .readFileSync(target, 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#') && l.includes('=')).length;
  if (count === 0) {
    err(`${target} contains no variables. Refusing to overwrite the remote secret with an empty payload.`);
    process.exit(1);
  }
  out(`Pushed ${count} variables from ${target} into secret "production".`);
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
  process.exit(0);
}

if (group === 'teams' && sub === 'list') {
  requireAuth();
  out('ID: 12ab34cd | Email: mohmad@oneguard.one | Role: owner');
  out('ID: 56ef78ab | Email: dev@oneguard.one | Role: member');
  process.exit(0);
}

if (group === 'teams' && sub === 'role') {
  requireWrite();
  const member = opt('member');
  const role = opt('role');
  if (member === 'dev@oneguard.one' && role === 'owner') {
    err('Admins cannot promote users to Admin or Owner');
    process.exit(1);
  }
  out(`Role updated: ${member} is now ${role}.`);
  process.exit(0);
}

if (group === 'teams' && sub === 'remove') {
  requireWrite();
  const member = opt('member');
  if (!argv.includes('--yes')) {
    err(`This removes "${member}" from the organization and revokes their access. Re-run with --yes to confirm.`);
    process.exit(1);
  }
  out(`Removed ${member} from the organization.`);
  process.exit(0);
}

if (group === 'logs' && sub === 'list') {
  requireAuth();
  out('[2026-09-06 10:00:00.000] [create] Mohmad: project/oneguard-api');
  out('[2026-09-06 10:05:00.000] [update] Dev: secret/production');
  process.exit(0);
}

err(`Could not find a command named "${argv.join(' ')}".`);
process.exit(64);
