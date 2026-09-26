import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  API_KEY,
  CLI_PATH,
  CLI_TIMEOUT_MS,
  MCP_CREDENTIALS_FILE,
  MCP_HOME,
  MIN_CLI_VERSION,
} from './config.js';
import { log } from './logger.js';

/** Error the model is allowed to see, with a message written for it. */
export class ToolError extends Error {
  /**
   * @param {string} message
   * @param {string} [code] stable code from the CLI's `--json` error output
   */
  constructor(message, code) {
    super(message);
    this.name = 'ToolError';
    /** @type {string|undefined} */
    this.code = code;
  }
}

/**
 * @typedef {object} CliResult
 * @property {number} code
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Key for this session, when it came from the oneguard_init tool rather than
 * the server's environment. Held in memory only and never written to disk.
 * @type {string}
 */
let sessionKey = '';

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
    const key = sessionKey || API_KEY;

    const child = spawn(CLI_PATH, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // Isolate the CLI's credential/config store from the user's own.
        HOME: MCP_HOME,
        USERPROFILE: MCP_HOME,
        // From CLI 1.3.0 this is all the authentication the subprocess needs,
        // and nothing is written to disk at all. Older CLIs ignore it and go
        // through `auth login` instead (see ensureAuth).
        ...(key ? { ONEGUARD_API_KEY: key } : {}),
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

// ---------------------------------------------------------------- version ---

/** @type {{version: string|null, supportsJson: boolean}|null} */
let versionInfo = null;

/**
 * Compares dotted version strings. Missing parts count as zero.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b
 */
function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Asks the CLI what version it is, once per process.
 *
 * This is the whole reason `oneguard --version` exists. Without it the only way
 * to find out whether the binary in front of us understands `--json` is to pass
 * the flag and see what breaks — and what breaks is a usage error in the middle
 * of a user's request, not at startup.
 *
 * A CLI too old to answer reports `null`, which is not an error: the server
 * falls back to parsing the human-readable output, exactly as it did before.
 *
 * @returns {Promise<{version: string|null, supportsJson: boolean}>}
 */
export async function cliVersion() {
  if (versionInfo) return versionInfo;

  let version = null;
  try {
    const res = await runCli(['--version']);
    if (res.code === 0) {
      const m = res.stdout.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
      if (m) version = m[1];
    }
  } catch {
    // A CLI that cannot even be started is reported by the next real call,
    // with a message about that call rather than about version detection.
  }

  versionInfo = {
    version,
    supportsJson: version !== null && compareVersions(version, MIN_CLI_VERSION) >= 0,
  };

  log(
    version
      ? `oneguard CLI ${version} (structured output: ${versionInfo.supportsJson ? 'yes' : 'no'})`
      : 'oneguard CLI version unknown; falling back to text parsing',
  );
  return versionInfo;
}

// ------------------------------------------------------------------ errors ---

/**
 * Turns a failed run into a ToolError, preferring the structured error the CLI
 * prints under `--json` over the prose on stderr.
 *
 * @param {CliResult} res
 * @returns {ToolError}
 */
function toToolError(res) {
  const parsed = parseJsonLine(res.stdout);
  if (parsed && parsed.ok === false && parsed.error) {
    return new ToolError(
      String(parsed.error.message || 'The oneguard CLI reported an error.'),
      parsed.error.code ? String(parsed.error.code) : undefined,
    );
  }
  const detail = (res.stderr || res.stdout || '').trim();
  return new ToolError(detail || `The oneguard CLI exited with code ${res.code}.`);
}

/**
 * The CLI emits exactly one JSON object under `--json`, but warnings can share
 * the stream in odd environments, so take the last line that parses.
 *
 * @param {string} out
 * @returns {any|null}
 */
function parseJsonLine(out) {
  const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Not the JSON line. Keep looking backwards.
    }
  }
  return null;
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
  if (res.code !== 0) throw toToolError(res);
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
 *
 * Only used with a CLI older than {@link MIN_CLI_VERSION}. From 1.3.0 the key
 * travels in the subprocess environment and no credential is written to disk.
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
 * Records a key supplied at run time by the oneguard_init tool.
 * @param {string} apiKey
 */
export function setSessionKey(apiKey) {
  sessionKey = apiKey;
  authReady = false;
}

/** The key this server will hand the CLI, if any. */
export function effectiveKey() {
  return sessionKey || API_KEY;
}

/**
 * Makes sure the CLI subprocess will be authenticated before a tool runs.
 *
 * With CLI 1.3.0+ there is nothing to do: the key is handed to each subprocess
 * in its environment, so there is no login step, no stored credential, and
 * nothing to go stale. With an older CLI the key still has to be written into
 * the isolated home by `auth login` first.
 *
 * @returns {Promise<void>}
 */
export async function ensureAuth() {
  if (authReady) return;

  const key = effectiveKey();
  const { supportsJson } = await cliVersion();

  if (key && supportsJson) {
    authReady = true;
    return;
  }

  if (hasStoredKey()) {
    authReady = true;
    return;
  }

  if (key) {
    log('bootstrapping isolated session from the configured API key');
    await loginWithKey(key);
    return;
  }

  throw new ToolError(
    'Not initialized. Set ONEGUARD_API_KEY in this MCP server\'s environment ' +
      '(recommended), or call the oneguard_init tool with an API key. ' +
      'Ask the user for the key — never guess one.',
    'not_initialized',
  );
}

/**
 * Runs an authenticated CLI command, re-initializing once if the stored key
 * turned out to be stale.
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
    const key = effectiveKey();
    if (key && !hasStoredKey()) {
      log('session was rejected; re-initializing');
      const { supportsJson } = await cliVersion();
      if (!supportsJson) await loginWithKey(key);
      authReady = true;
      const retry = await runCli(args, opts);
      if (retry.code === 0) return retry.stdout;
      throw toToolError(retry);
    }
  }

  if (res.code !== 0) throw toToolError(res);
  return res.stdout;
}

/**
 * Runs an authenticated command and returns both the structured result and the
 * raw output.
 *
 * On a CLI that supports it, `--json` is prepended and `json` holds the parsed
 * object. On an older CLI, `json` is null and the caller falls back to the
 * text parsers — which is why those still exist.
 *
 * @param {string[]} args
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<{json: any|null, raw: string}>}
 */
export async function runStructured(args, opts = {}) {
  const { supportsJson } = await cliVersion();
  // The flag is global and must come before the command.
  const out = await runAuthed(supportsJson ? ['--json', ...args] : args, opts);
  return { json: supportsJson ? parseJsonLine(out) : null, raw: out };
}

export { parseJsonLine };
