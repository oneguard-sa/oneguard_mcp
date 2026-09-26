import { runAuthed, runStructured, ToolError } from '../cli.js';
import { findByIdPrefix, parseCreatedId } from '../parsers.js';
import { listSecrets } from '../structured.js';
import { fileExists, requireProjectDir, resolveEnvPath } from '../workspace.js';
import { object, str, PROJECT_DIR } from './schema.js';

/** @param {unknown} v @param {string} field */
function requireStr(v, field) {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new ToolError(`${field} is required.`);
  }
  return v.trim();
}

/**
 * Resolves the payload flags shared by `secrets add` and `secrets edit`.
 *
 * The CLI takes either a single --key/--value pair or a --file of KEY=VALUE
 * lines, and in both cases the payload it sends REPLACES whatever the secret
 * held before. That is the CLI's semantics, not something this server can
 * soften, so the tool descriptions say so plainly and point at
 * oneguard_secrets_generate for the merging case.
 *
 * @param {Record<string, any>} args
 * @returns {string[]} extra CLI flags
 */
function payloadFlags(args) {
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  const value = typeof args.value === 'string' ? args.value : '';
  const fromFile = typeof args.from_env_file === 'string' ? args.from_env_file.trim() : '';

  if (fromFile) {
    const dir = requireProjectDir(args.project_dir);
    const abs = resolveEnvPath(dir, fromFile);
    if (!fileExists(abs)) {
      throw new ToolError(`Env file not found: ${abs}`);
    }
    return ['--file', abs];
  }

  if (key && value) return ['--key', key, '--value', value];

  throw new ToolError(
    'Provide either from_env_file (with project_dir) — preferred — or both key and value.',
  );
}

/** @type {import('../rpc.js').ToolDef[]} */
export const secretTools = [
  {
    name: 'oneguard_secrets_list',
    title: 'List secrets in a vault',
    description:
      'Lists the secrets of a vault: id prefix, name, and whether it is archived. Values are never returned by any tool in this server.',
    inputSchema: object(
      { vault: str('Vault id or its 8-character prefix.') },
      ['vault'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args) {
      const vault = requireStr(args.vault, 'vault');
      const { rows, raw, structured } = await listSecrets(vault);
      return {
        vault,
        count: rows.length,
        secrets: rows,
        structured,
        raw: raw.trim(),
      };
    },
  },
  {
    name: 'oneguard_secrets_add',
    title: 'Create a secret',
    description:
      'Creates a new secret in a vault from a local .env file (preferred) or from a single key/value pair. ' +
      'Prefer from_env_file: passing a value directly means the secret value travels through this conversation. ' +
      'To create a secret holding a NEW generated value, create it here and then use oneguard_secrets_generate, which never reveals the value. ' +
      'Never invent secret values — only use what the user explicitly provided or what is already in their .env file.',
    inputSchema: object(
      {
        vault: str('Vault id or its 8-character prefix.'),
        name: str('Name for the new secret (e.g. "production", "staging").'),
        project_dir: PROJECT_DIR,
        from_env_file: str(
          'Path to a .env file, relative to project_dir (default ".env"). Preferred over key/value.',
        ),
        key: str('Single key name. Only when not using from_env_file.'),
        value: str('Single value. Only when not using from_env_file.'),
      },
      ['vault', 'name'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    async handler(args) {
      const vault = requireStr(args.vault, 'vault');
      const name = requireStr(args.name, 'name');
      const flags = payloadFlags(args);
      const { json, raw: out } = await runStructured([
        'secrets', 'add', '--project', vault, '--name', name, ...flags,
      ]);
      return {
        created: true,
        vault,
        name,
        id: json?.secret?.id ?? parseCreatedId(out),
        variables: json?.variables,
        source: flags[0] === '--file' ? 'env file' : 'key/value',
        raw: out.trim(),
      };
    },
  },
  {
    name: 'oneguard_secrets_edit',
    title: 'Replace a secret\'s contents',
    description:
      'Replaces a secret\'s stored payload. IMPORTANT: this overwrites the whole payload — a single key/value pair replaces every key the secret held. ' +
      'To change one variable while keeping the rest: for a generated value use oneguard_secrets_generate (which merges), otherwise sync the secret to a .env file, edit that file, and push it back with from_env_file. ' +
      'Confirm with the user before calling this.',
    inputSchema: object(
      {
        vault: str('Vault id or its 8-character prefix.'),
        secret: str('Secret id or its 8-character prefix.'),
        name: str('Secret name. Required by the CLI; omit to reuse the current name.'),
        project_dir: PROJECT_DIR,
        from_env_file: str(
          'Path to a .env file, relative to project_dir (default ".env"). Preferred: sends the full set of variables.',
        ),
        key: str('Single key name. WARNING: replaces all other keys.'),
        value: str('Single value. WARNING: replaces all other keys.'),
      },
      ['vault', 'secret'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    async handler(args) {
      const vault = requireStr(args.vault, 'vault');
      const secret = requireStr(args.secret, 'secret');

      // --name is mandatory in the CLI; look up the current one when the caller
      // only wants to change contents.
      let name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) {
        const { rows: listing } = await listSecrets(vault);
        const match = findByIdPrefix(listing, secret);
        if (!match) {
          throw new ToolError(
            `No secret matching "${secret}" in vault ${vault}. Call oneguard_secrets_list first.`,
          );
        }
        name = match.name;
      }

      const flags = payloadFlags(args);
      const out = await runAuthed([
        'secrets', 'edit', '--project', vault, '--id', secret, '--name', name, ...flags,
      ]);
      return {
        updated: true,
        vault,
        secret,
        name,
        payload_replaced: true,
        raw: out.trim(),
      };
    },
  },
  {
    name: 'oneguard_secrets_archive',
    title: 'Archive a secret',
    description:
      'Archives a secret. It stops appearing as active but is not deleted. Confirm with the user before calling.',
    inputSchema: object(
      {
        vault: str('Vault id or its 8-character prefix.'),
        secret: str('Secret id or its 8-character prefix.'),
      },
      ['vault', 'secret'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async handler(args) {
      const vault = requireStr(args.vault, 'vault');
      const secret = requireStr(args.secret, 'secret');
      const out = await runAuthed([
        'secrets', 'archive', '--project', vault, '--id', secret,
      ]);
      return { archived: true, vault, secret, raw: out.trim() };
    },
  },
  {
    name: 'oneguard_secrets_delete',
    title: 'Delete a secret',
    description:
      'Permanently deletes a secret and everything stored in it. This cannot be undone. ' +
      'Only call this after the user has explicitly asked for this specific secret to be deleted, and read the secret name back to them first.',
    inputSchema: object(
      {
        vault: str('Vault id or its 8-character prefix.'),
        secret: str('Secret id or its 8-character prefix.'),
        confirm: str(
          'Must be exactly the secret\'s name, as a guard against deleting the wrong one. Get it from oneguard_secrets_list.',
        ),
      },
      ['vault', 'secret', 'confirm'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    async handler(args) {
      const vault = requireStr(args.vault, 'vault');
      const secret = requireStr(args.secret, 'secret');
      const confirm = requireStr(args.confirm, 'confirm');

      const { rows: listing } = await listSecrets(vault);
      const match = findByIdPrefix(listing, secret);
      if (!match) {
        throw new ToolError(`No secret matching "${secret}" in vault ${vault}.`);
      }
      if (match.name !== confirm) {
        throw new ToolError(
          `Refusing to delete: confirm was "${confirm}" but secret ${secret} is named "${match.name}". Check with the user which one they mean.`,
        );
      }

      const out = await runAuthed([
        'secrets', 'delete', '--project', vault, '--id', secret,
      ]);
      return { deleted: true, vault, secret, name: match.name, raw: out.trim() };
    },
  },
];
