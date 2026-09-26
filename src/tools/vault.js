import { runAuthed, runStructured, ToolError } from '../cli.js';
import { parseCreatedId } from '../parsers.js';
import { listVaults } from '../structured.js';
import { object, str } from './schema.js';

/**
 * Vaults — what the CLI called `projects` before 1.1.0.
 *
 * The CLI keeps `projects` as a hidden alias for compatibility, but the MCP
 * tools do not: an agent picks tools by name and description, so carrying two
 * names for one thing only creates ambiguity about which to call.
 */

/** @param {unknown} v @param {string} field */
function requireStr(v, field) {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new ToolError(`${field} is required.`);
  }
  return v.trim();
}

/** @type {import('../rpc.js').ToolDef[]} */
export const vaultTools = [
  {
    name: 'oneguard_vault_list',
    title: 'List vaults',
    description:
      'Lists every vault in the organization, with the 8-character id prefix that other tools accept as a vault argument. A vault is the container that secrets live in.',
    inputSchema: object({}),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler() {
      const { rows, raw, structured } = await listVaults();
      return { count: rows.length, vaults: rows, structured, raw: raw.trim() };
    },
  },
  {
    name: 'oneguard_vault_add',
    title: 'Create a vault',
    description:
      'Creates a new vault in the organization and returns its id. A vault is the container that secrets live in.',
    inputSchema: object({ name: str('Name of the new vault.') }, ['name']),
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler(args) {
      const name = requireStr(args.name, 'name');
      const { json, raw } = await runStructured(['vault', 'add', '--name', name]);
      return {
        created: true,
        name,
        id: json?.vault?.id ?? parseCreatedId(raw),
        raw: raw.trim(),
      };
    },
  },
  {
    name: 'oneguard_vault_rename',
    title: 'Rename a vault',
    description:
      'Renames an existing vault. Secrets, links and ids are unaffected — only the display name changes.',
    inputSchema: object(
      {
        vault: str('Vault id or its 8-character prefix.'),
        name: str('The new vault name.'),
      },
      ['vault', 'name'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async handler(args) {
      const vault = requireStr(args.vault, 'vault');
      const name = requireStr(args.name, 'name');
      const out = await runAuthed(['vault', 'edit', '--id', vault, '--name', name]);
      return { updated: true, vault, name, raw: out.trim() };
    },
  },
];
