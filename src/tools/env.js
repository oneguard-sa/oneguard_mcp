import path from 'node:path';

import { runAuthed, ToolError } from '../cli.js';
import { findByIdPrefix, parseProjects, parseSecrets } from '../parsers.js';
import {
  clearLink,
  fileExists,
  readEnvKeys,
  readLink,
  requireProjectDir,
  resolveEnvPath,
  writeLink,
} from '../workspace.js';
import { bool, object, str, PROJECT_DIR } from './schema.js';

/**
 * The headline feature: `sync`.
 *
 * The CLI's own `env sync` is interactive — it prints a numbered menu and
 * blocks on stdin — which can never work from an MCP server, because there is
 * no human on the other end of that pipe. So this reimplements the selection
 * flow non-interactively: the link file the CLI reads and writes (`.oneguard`)
 * is managed here, and the transfer itself is delegated to the CLI's
 * non-interactive paths — `env pull` downward, `env sync --push` upward.
 *
 * The result is a directory that stays compatible in both directions: a folder
 * linked by this tool works with plain `oneguard env sync` in a terminal, and a
 * folder the user already linked there is picked up here with no arguments.
 *
 * Note that `project_dir` is a directory on disk, not a vault — the two are
 * different things and the names stay distinct.
 */

/** @type {import('../rpc.js').ToolDef[]} */
export const envTools = [
  {
    name: 'oneguard_env_sync',
    title: 'Sync secrets into a directory\'s .env file',
    description:
      'THE MAIN TOOL. Fetches the secret linked to a directory and writes it into that directory\'s .env file, then remembers the link for next time. ' +
      'Call it with only project_dir when the directory is already linked (it re-pulls the latest values). ' +
      'If it is not linked yet, this returns the list of vaults (or secrets) to choose from — show those to the user, let THEM pick, then call again with vault and secret. ' +
      'Returns only the variable NAMES that were written; values go to disk and are never shown.',
    inputSchema: object(
      {
        project_dir: PROJECT_DIR,
        vault: str(
          'Vault id or 8-character prefix. Omit if the directory is already linked.',
        ),
        secret: str(
          'Secret id or 8-character prefix. Omit if the directory is already linked.',
        ),
        path: str('Env file path relative to project_dir. Defaults to ".env".'),
        relink: bool(
          'Ignore the existing link and set a new one. Use when the user wants to point this directory at a different secret.',
          false,
        ),
      },
      ['project_dir'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(args) {
      const dir = requireProjectDir(args.project_dir);
      const relink = args.relink === true;
      const link = relink ? {} : readLink(dir);

      let vaultId =
        (typeof args.vault === 'string' && args.vault.trim()) ||
        link.project_id ||
        '';
      let secretId =
        (typeof args.secret === 'string' && args.secret.trim()) ||
        (args.vault ? '' : link.secret_id) ||
        '';

      // Step 1 — which vault? Hand the choice back to the user via the model.
      if (!vaultId) {
        const vaults = parseProjects(await runAuthed(['vault', 'list']));
        if (vaults.length === 0) {
          throw new ToolError(
            'No vaults found in this organization. Create one first with oneguard_vault_add.',
          );
        }
        return {
          status: 'needs_selection',
          needs: 'vault',
          project_dir: dir,
          vaults,
          next_step:
            'Ask the user which vault this directory belongs to, then call oneguard_env_sync again with vault set. Do not pick for them.',
        };
      }

      // Step 2 — which secret inside it?
      const secrets = parseSecrets(
        await runAuthed(['secrets', 'list', '--project', vaultId]),
      );
      if (secrets.length === 0) {
        throw new ToolError(
          `Vault ${vaultId} has no secrets yet. Create one with oneguard_secrets_add.`,
        );
      }

      if (!secretId) {
        if (secrets.length === 1) {
          secretId = secrets[0].id;
        } else {
          return {
            status: 'needs_selection',
            needs: 'secret',
            project_dir: dir,
            vault: vaultId,
            secrets: secrets.filter((s) => !s.archived),
            next_step:
              'Ask the user which secret to sync, then call oneguard_env_sync again with both vault and secret.',
          };
        }
      }

      const matched = findByIdPrefix(secrets, secretId);
      if (!matched) {
        throw new ToolError(
          `No secret matching "${secretId}" in vault ${vaultId}. Call oneguard_secrets_list to see what is available.`,
        );
      }

      // Step 3 — write the link the CLI itself understands, then pull.
      const target = resolveEnvPath(dir, args.path);
      writeLink(dir, vaultId, matched.id);

      const out = await runAuthed(
        [
          'env', 'pull',
          '--id', matched.id,
          '--project', vaultId,
          '--path', target,
        ],
        { cwd: dir },
      );

      const keys = readEnvKeys(target);
      return {
        status: 'synced',
        vault: vaultId,
        secret: { id: matched.id, name: matched.name },
        file: target,
        relative_file: path.relative(dir, target),
        variable_count: keys.length,
        variables: keys,
        linked: true,
        note: 'Values were written to the file only. This server never returns secret values.',
        raw: out.trim(),
      };
    },
  },
  {
    name: 'oneguard_env_status',
    title: 'Show a directory\'s sync state',
    description:
      'Reports whether a directory is linked to a OneGuard secret, which one, and which variable names its .env currently holds. Read-only.',
    inputSchema: object(
      {
        project_dir: PROJECT_DIR,
        path: str('Env file path relative to project_dir. Defaults to ".env".'),
      },
      ['project_dir'],
    ),
    annotations: { readOnlyHint: true },
    async handler(args) {
      const dir = requireProjectDir(args.project_dir);
      const link = readLink(dir);
      const target = resolveEnvPath(dir, args.path);
      const exists = fileExists(target);

      /** @type {string|null} */
      let secretName = null;
      if (link.project_id && link.secret_id) {
        try {
          const secrets = parseSecrets(
            await runAuthed(['secrets', 'list', '--project', link.project_id]),
          );
          secretName = findByIdPrefix(secrets, link.secret_id)?.name ?? null;
        } catch {
          // A broken link should still report its raw state rather than fail.
          secretName = null;
        }
      }

      return {
        project_dir: dir,
        linked: Boolean(link.project_id && link.secret_id),
        vault: link.project_id ?? null,
        secret: link.secret_id ?? null,
        secret_name: secretName,
        env_file: target,
        env_file_exists: exists,
        variables: exists ? readEnvKeys(target) : [],
      };
    },
  },
  {
    name: 'oneguard_env_push',
    title: 'Push a local .env back to OneGuard',
    description:
      'Uploads the variables in a directory\'s .env file into the secret that directory is linked to, REPLACING what the secret held. ' +
      'The reverse of oneguard_env_sync. Confirm with the user first, and tell them which variable names are about to be uploaded. ' +
      'To add a single generated value without touching the rest, use oneguard_secrets_generate instead.',
    inputSchema: object(
      {
        project_dir: PROJECT_DIR,
        path: str('Env file path relative to project_dir. Defaults to ".env".'),
      },
      ['project_dir'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async handler(args) {
      const dir = requireProjectDir(args.project_dir);
      const link = readLink(dir);
      if (!link.project_id || !link.secret_id) {
        throw new ToolError(
          `${dir} is not linked to a OneGuard secret yet. Run oneguard_env_sync first.`,
        );
      }

      const target = resolveEnvPath(dir, args.path);
      if (!fileExists(target)) {
        throw new ToolError(`Env file not found: ${target}`);
      }
      const keys = readEnvKeys(target);
      if (keys.length === 0) {
        throw new ToolError(
          `${target} contains no variables. Refusing to overwrite the remote secret with an empty payload.`,
        );
      }

      const secrets = parseSecrets(
        await runAuthed(['secrets', 'list', '--project', link.project_id]),
      );
      const matched = findByIdPrefix(secrets, link.secret_id);
      if (!matched) {
        throw new ToolError(
          `The linked secret ${link.secret_id} no longer exists in vault ${link.project_id}. Re-link with oneguard_env_sync (relink: true).`,
        );
      }

      // `env sync --push` is the CLI's own reverse direction: it reads the same
      // .oneguard link, looks the secret's current name up itself (so a push
      // cannot rename the secret), and refuses an empty file.
      const out = await runAuthed(
        ['env', 'sync', '--push', '--path', target],
        { cwd: dir },
      );

      return {
        status: 'pushed',
        vault: link.project_id,
        secret: { id: matched.id, name: matched.name },
        file: target,
        variable_count: keys.length,
        variables: keys,
        payload_replaced: true,
        raw: out.trim(),
      };
    },
  },
  {
    name: 'oneguard_env_unlink',
    title: 'Unlink a directory',
    description:
      'Removes the .oneguard link file from a directory. The .env file on disk is left untouched. Equivalent to `oneguard env sync --reset`.',
    inputSchema: object({ project_dir: PROJECT_DIR }, ['project_dir']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async handler(args) {
      const dir = requireProjectDir(args.project_dir);
      const removed = clearLink(dir);
      return {
        project_dir: dir,
        unlinked: removed,
        note: removed
          ? 'Link removed. The .env file was not touched.'
          : 'This directory was not linked.',
      };
    },
  },
];
