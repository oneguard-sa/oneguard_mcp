import {
  cliVersion,
  effectiveKey,
  ensureAuth,
  invalidateAuth,
  loginWithKey,
  runStructured,
  setSessionKey,
  ToolError,
} from '../cli.js';
import {
  API_KEY,
  CLI_PATH,
  MCP_HOME,
  MIN_CLI_VERSION,
  READ_ONLY,
} from '../config.js';
import { parseKeyPermission, parseOrgId } from '../parsers.js';
import { object, str } from './schema.js';

/**
 * Reads `oneguard status` in whichever form the installed CLI can give it.
 *
 * @returns {Promise<{org_id: string|null, permission: 'read'|'write'|null, storage: string|null, encryption: any, structured: boolean, raw: string}>}
 */
async function readStatus() {
  const { json, raw } = await runStructured(['status']);
  if (json) {
    const permission =
      json.key_permission === 'read' || json.key_permission === 'write'
        ? json.key_permission
        : null;
    return {
      org_id: typeof json.org_id === 'string' ? json.org_id : null,
      permission,
      storage:
        typeof json.credential_storage === 'string'
          ? json.credential_storage
          : null,
      encryption: json.encryption ?? null,
      structured: true,
      raw,
    };
  }
  return {
    org_id: parseOrgId(raw),
    permission: parseKeyPermission(raw),
    storage: null,
    encryption: null,
    structured: false,
    raw,
  };
}

/** @type {import('../rpc.js').ToolDef[]} */
export const authTools = [
  {
    name: 'oneguard_init',
    title: 'Initialize the OneGuard session',
    description:
      'Initializes this server\'s isolated OneGuard session with an API key and verifies it against the backend. ' +
      'Normally you do NOT need to call this: if ONEGUARD_API_KEY is configured on the server, the session initializes itself on the first tool call. ' +
      'Call this only when another tool reports that the server is not initialized, and only with a key the user gave you in this conversation — never invent one. ' +
      'The key is kept for this session only and does not affect the user\'s own `oneguard` login in their terminal.',
    inputSchema: object({
      api_key: str(
        'The OneGuard API key. Omit to use the ONEGUARD_API_KEY configured on the server.',
      ),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async handler(args) {
      const key = typeof args.api_key === 'string' ? args.api_key.trim() : '';
      const effective = key || API_KEY;
      if (!effective) {
        throw new ToolError(
          'No API key available. Either set ONEGUARD_API_KEY in the MCP server configuration, or ask the user for a key and pass it as api_key.',
        );
      }

      invalidateAuth();
      if (key) setSessionKey(key);

      const { version, supportsJson } = await cliVersion();

      // With CLI 1.3.0+ the key travels in the subprocess environment and no
      // credential is ever written to disk. Only an older CLI needs the key
      // stored, and only then is `auth login` used.
      if (!supportsJson) {
        await loginWithKey(effective);
      }

      const status = await readStatus();
      return {
        initialized: true,
        source: key ? 'api_key argument' : 'ONEGUARD_API_KEY',
        cli_version: version,
        org_id: status.org_id,
        key_permission: status.permission,
        can_write:
          status.permission === null ? null : status.permission === 'write',
        credential_storage: supportsJson
          ? 'process environment (nothing written to disk)'
          : `isolated config directory (${MCP_HOME})`,
        read_only: READ_ONLY,
        note: 'The API key is never returned by any tool.',
      };
    },
  },
  {
    name: 'oneguard_status',
    title: 'Check OneGuard connection',
    description:
      'Verifies that the OneGuard CLI is installed, the session is initialized, and the backend is reachable. Returns the organization id and whether the configured API key may write. Use this first when something is not working, or before a batch of changes.',
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler() {
      await ensureAuth();
      const { version, supportsJson } = await cliVersion();
      const status = await readStatus();

      return {
        ok: true,
        org_id: status.org_id,
        key_permission: status.permission,
        can_write:
          status.permission === null ? null : status.permission === 'write',
        ...(status.permission === 'read'
          ? {
              note: 'This API key is read-only. Any tool that creates, changes or deletes something will be refused by the server. Tell the user they need a key with write permission.',
            }
          : {}),
        cli_path: CLI_PATH,
        cli_version: version,
        // Worth surfacing: on an older CLI this server recovers structure by
        // matching regular expressions against output meant for people, which
        // is fragile in a way the user can fix by upgrading.
        structured_output: supportsJson,
        ...(supportsJson
          ? {}
          : {
              upgrade_note: `The installed oneguard CLI${version ? ` (${version})` : ''} is older than ${MIN_CLI_VERSION}, so this server is parsing human-readable output and storing a credential on disk. Upgrading removes both.`,
            }),
        credential_storage: supportsJson
          ? 'process environment (nothing written to disk)'
          : `isolated config directory (${MCP_HOME})`,
        key_source: effectiveKey() ? 'configured' : 'none',
        ...(status.storage ? { cli_credential_storage: status.storage } : {}),
        ...(status.encryption ? { encryption: status.encryption } : {}),
        config_home: MCP_HOME,
        read_only: READ_ONLY,
        raw: status.raw.trim(),
      };
    },
  },
];
