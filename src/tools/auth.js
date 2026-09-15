import {
  ensureAuth,
  invalidateAuth,
  loginWithKey,
  runAuthed,
  ToolError,
} from '../cli.js';
import { API_KEY, CLI_PATH, MCP_HOME, READ_ONLY } from '../config.js';
import { parseKeyPermission, parseOrgId } from '../parsers.js';
import { object, str } from './schema.js';

/** @type {import('../rpc.js').ToolDef[]} */
export const authTools = [
  {
    name: 'oneguard_init',
    title: 'Initialize the OneGuard session',
    description:
      'Initializes this server\'s isolated OneGuard session with an API key and verifies it against the backend. ' +
      'Normally you do NOT need to call this: if ONEGUARD_API_KEY is configured on the server, the session initializes itself on the first tool call. ' +
      'Call this only when another tool reports that the server is not initialized, and only with a key the user gave you in this conversation — never invent one. ' +
      'The key is stored in an isolated config directory and does not affect the user\'s own `oneguard` login in their terminal.',
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
      await loginWithKey(effective);
      const out = await runAuthed(['status']);
      const permission = parseKeyPermission(out);
      return {
        initialized: true,
        source: key ? 'api_key argument' : 'ONEGUARD_API_KEY',
        org_id: parseOrgId(out),
        key_permission: permission,
        can_write: permission === null ? null : permission === 'write',
        config_home: MCP_HOME,
        read_only: READ_ONLY,
        note: 'Credentials are stored in an isolated home and never returned by any tool.',
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
      const out = await runAuthed(['status']);
      const permission = parseKeyPermission(out);
      return {
        ok: true,
        org_id: parseOrgId(out),
        key_permission: permission,
        can_write: permission === null ? null : permission === 'write',
        ...(permission === 'read'
          ? {
              note: 'This API key is read-only. Any tool that creates, changes or deletes something will be refused by the server. Tell the user they need a key with write permission.',
            }
          : {}),
        cli_path: CLI_PATH,
        config_home: MCP_HOME,
        read_only: READ_ONLY,
        raw: out.trim(),
      };
    },
  },
];
