import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  API_KEY,
  CLI_PATH,
  CLI_TIMEOUT_MS,
  MCP_CREDENTIALS_FILE,
  MCP_HOME,
} from './config.js';
import { log } from './logger.js';

/** Error the model is allowed to see, with a message written for it. */
export class ToolError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * @typedef {object} CliResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Runs the OneGuard CLI once and captures its output.
 *
 * stdin is deliberately closed: any command that tries to prompt (the CLI's
 * own `env sync` / `env resync`) fails immediately instead of hanging the
 * server forever waiting on a human who is not there.
 *
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<CliResult>}
 */
export function runCli(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_PATH, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // Isolate the CLI's credential/config store from the user's own.
        HOME: MCP_HOME,
        USERPROFILE: MCP_HOME,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new ToolError(
          `The oneguard CLI did not finish within ${CLI_TIMEOUT_MS}ms and was terminated.`,
        ),
      );
    }, CLI_TIMEOUT_MS);

    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const e = /** @type {NodeJS.ErrnoException} */ (err);
      if (e.code === 'ENOENT') {
        reject(
          new ToolError(
            `Could not find the oneguard CLI at "${CLI_PATH}". Install it, or set ONEGUARD_CLI_PATH to its absolute path in the MCP server configuration.`,
          ),
        );
        return;
      }
      reject(new ToolError(`Failed to run the oneguard CLI: ${e.message}`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Runs the CLI and throws a ToolError on a non-zero exit.
 *
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<string>} stdout
 */
export async function runCliChecked(args, opts = {}) {
  const res = await runCli(args, opts);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new ToolError(
      detail || `The oneguard CLI exited with code ${res.code}.`,
    );
  }
  return res.stdout;
}

/** In-memory latch so we don't stat the credentials file on every call. */
let authReady = false;

/** Forget the cached auth state (after a 401, or an explicit re-init). */
export function invalidateAuth() {
  authReady = false;
}

/** @returns {boolean} */
function hasStoredKey() {
  try {
    const raw = fs.readFileSync(MCP_CREDENTIALS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.api_key === 'string' && parsed.api_key.length > 0;
  } catch {
    return false;
  }
}

/**
 * Logs the isolated CLI session in with the given key.
 * The key is passed as a process argument to the CLI and is never returned.
 *
 * @param {string} apiKey
 * @returns {Promise<void>}
 */
export async function loginWithKey(apiKey) {
  fs.mkdirSync(path.join(MCP_HOME, '.oneguard'), { recursive: true });
  const res = await runCli(['auth', 'login', apiKey]);
  if (res.code !== 0) {
    authReady = false;
    const detail = (res.stderr || res.stdout || '').trim();
    throw new ToolError(
      `Login failed. The API key was rejected by OneGuard. ${detail}`.trim(),
    );
  }
  authReady = true;
}

/**
 * Makes sure the isolated CLI session is authenticated before a tool runs.
 *
 * Order: an already-stored key wins; otherwise ONEGUARD_API_KEY bootstraps the
 * session automatically (this is the "init" step, done lazily so starting the
 * server never blocks on the network); otherwise the caller is told what to do.
 *
 * @returns {Promise<void>}
 */
export async function ensureAuth() {
  if (authReady) return;

  if (hasStoredKey()) {
    authReady = true;
    return;
  }

  if (API_KEY) {
    log('bootstrapping isolated session from ONEGUARD_API_KEY');
    await loginWithKey(API_KEY);
    return;
  }

  throw new ToolError(
    'Not initialized. Set ONEGUARD_API_KEY in this MCP server\'s environment ' +
      '(recommended), or call the oneguard_init tool with an API key. ' +
      'Ask the user for the key — never guess one.',
  );
}

/**
 * Runs an authenticated CLI command, re-initializing once if the stored key
 * turned out to be stale.
 *
 * The CLI clears its stored key on an unauthorized response, so after a 401 the
 * credentials file is gone; if ONEGUARD_API_KEY is set we can silently recover.
 *
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<string>}
 */
export async function runAuthed(args, opts = {}) {
  await ensureAuth();
  const res = await runCli(args, opts);

  // Only the CLI's own sign-out hint counts as "the session is dead". Matching
  // loosely on "api key" used to catch a read-only key's 403 as well, which
  // triggered a pointless re-login and retry that failed the same way.
  if (res.code !== 0 && /oneguard auth login/i.test(res.stderr)) {
    invalidateAuth();
    if (API_KEY && !hasStoredKey()) {
      log('session was rejected; re-initializing from ONEGUARD_API_KEY');
      await loginWithKey(API_KEY);
      const retry = await runCli(args, opts);
      if (retry.code === 0) return retry.stdout;
      throw new ToolError((retry.stderr || retry.stdout || '').trim());
    }
  }

  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new ToolError(
      detail || `The oneguard CLI exited with code ${res.code}.`,
    );
  }
  return res.stdout;
}
