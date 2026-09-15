import os from 'node:os';
import path from 'node:path';

/**
 * Central place for every environment knob this server reads.
 *
 * Nothing here ever reaches the model: the API key is read from the process
 * environment and handed straight to the CLI subprocess.
 */

/** Where the `oneguard` binary lives. */
export const CLI_PATH = process.env.ONEGUARD_CLI_PATH || 'oneguard';

/**
 * Isolated HOME handed to every CLI subprocess.
 *
 * The CLI stores credentials in `$HOME/.oneguard/credentials.json` and global
 * config in `$HOME/.oneguard/config.json`. If we let it use the real HOME, an
 * `auth login` from this server would silently overwrite whatever key the user
 * is logged in with in their own terminal (and a 401 here would log them out
 * there, because runGuarded clears the key on unauthorized). So the subprocess
 * gets its own HOME and the two never touch.
 */
export const MCP_HOME =
  process.env.ONEGUARD_MCP_HOME || path.join(os.homedir(), '.oneguard-mcp');

/** Path of the credentials file inside the isolated home. */
export const MCP_CREDENTIALS_FILE = path.join(
  MCP_HOME,
  '.oneguard',
  'credentials.json',
);

/** API key used to bootstrap the isolated session, if provided. */
export const API_KEY = process.env.ONEGUARD_API_KEY || '';

/** When true, every mutating tool is hidden and refused. */
export const READ_ONLY =
  /^(1|true|yes)$/i.test(process.env.ONEGUARD_MCP_READONLY || '');

/** Hard timeout for a single CLI invocation. */
export const CLI_TIMEOUT_MS = Number(process.env.ONEGUARD_MCP_TIMEOUT_MS || 60_000);

export const SERVER_NAME = 'oneguard';
export const SERVER_VERSION = '0.3.0';
