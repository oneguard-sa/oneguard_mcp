import { runStructured } from './cli.js';
import {
  parseLogs,
  parseProjects,
  parseSecrets,
  parseTeams,
} from './parsers.js';

/**
 * One place that knows how to get a list out of the CLI, whichever CLI it is.
 *
 * From 1.3.0 the CLI answers `--json` with a real object and these functions
 * just read fields off it. Below that they fall back to the regular expressions
 * in `parsers.js`, so an older `oneguard` on someone's machine keeps working
 * rather than breaking the moment this server is updated.
 *
 * The JSON path is better than a tidier equivalent of the old one: it carries
 * **full ids** where the human output prints an 8-character prefix, so links
 * and follow-up calls are written with the whole identifier instead of a stub
 * the server hopes is unique.
 */

/** @typedef {{id: string, id_prefix?: string, name: string}} VaultRow */
/** @typedef {{id: string, id_prefix?: string, name: string, archived: boolean}} SecretRow */
/** @typedef {{id: string, id_prefix?: string, email: string, role: string}} MemberRow */

/**
 * @returns {Promise<{rows: VaultRow[], raw: string, structured: boolean}>}
 */
export async function listVaults() {
  const { json, raw } = await runStructured(['vault', 'list']);
  if (json && Array.isArray(json.vaults)) {
    return { rows: json.vaults, raw, structured: true };
  }
  return { rows: parseProjects(raw), raw, structured: false };
}

/**
 * @param {string} vault
 * @returns {Promise<{rows: SecretRow[], raw: string, structured: boolean}>}
 */
export async function listSecrets(vault) {
  const { json, raw } = await runStructured([
    'secrets', 'list', '--project', vault,
  ]);
  if (json && Array.isArray(json.secrets)) {
    return { rows: json.secrets, raw, structured: true };
  }
  return { rows: parseSecrets(raw), raw, structured: false };
}

/**
 * @returns {Promise<{rows: MemberRow[], raw: string, structured: boolean, ownerCount: number|null}>}
 */
export async function listMembers() {
  const { json, raw } = await runStructured(['teams', 'list']);
  if (json && Array.isArray(json.members)) {
    return {
      rows: json.members,
      raw,
      structured: true,
      ownerCount:
        typeof json.owner_count === 'number' ? json.owner_count : null,
    };
  }
  return { rows: parseTeams(raw), raw, structured: false, ownerCount: null };
}

/**
 * @returns {Promise<{rows: {time: string, action: string, user: string, resource: string}[], raw: string, structured: boolean}>}
 */
export async function listLogs() {
  const { json, raw } = await runStructured(['logs', 'list']);
  if (json && Array.isArray(json.entries)) {
    return { rows: json.entries, raw, structured: true };
  }
  return { rows: parseLogs(raw), raw, structured: false };
}
