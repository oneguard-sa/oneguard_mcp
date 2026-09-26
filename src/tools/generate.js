import { runCliChecked, runStructured, ToolError } from '../cli.js';
import { object, str, bool } from './schema.js';

/**
 * Value generation, mirroring the dashboard's password generator.
 *
 * Two tools with a deliberate split:
 *
 * - `oneguard_generate` produces a value and RETURNS it. Nothing is stored, so
 *   the value has to come back for it to be useful at all — but that means it
 *   lands in the conversation. Its description says so, and points at the other
 *   tool for the case where the value is destined for a secret anyway.
 *
 * - `oneguard_secrets_generate` generates straight into a stored secret and
 *   returns only the key name. The value never enters the model's context.
 *
 * When both would work, the second is the right one.
 */

/** Generator flags shared by both tools. */
const GENERATOR_PROPS = {
  length: {
    type: 'integer',
    description: 'Number of characters. Default 16.',
    minimum: 1,
    maximum: 4096,
  },
  lowercase: bool('Include a-z. Default true.'),
  uppercase: bool('Include A-Z. Default true.'),
  numbers: bool('Include 0-9. Default true.'),
  special: bool('Include !@#%^&*()-_=+[]{}|;:,.<>? . Default true.'),
  min_numbers: {
    type: 'integer',
    description: 'Minimum digits in the value. Default 2.',
    minimum: 0,
  },
  min_special: {
    type: 'integer',
    description: 'Minimum special characters. Default 2.',
    minimum: 0,
  },
};

/**
 * Turns the tool arguments into CLI flags.
 *
 * Booleans are only passed when explicitly false: the CLI defaults every class
 * to on, and `--no-x` is how it is turned off.
 *
 * @param {Record<string, any>} args
 * @returns {string[]}
 */
function generatorFlags(args) {
  /** @type {string[]} */
  const flags = [];

  if (args.length !== undefined) {
    if (!Number.isInteger(args.length) || args.length < 1) {
      throw new ToolError('length must be a positive whole number.');
    }
    flags.push('--length', String(args.length));
  }
  for (const [key, flag] of [
    ['lowercase', 'lowercase'],
    ['uppercase', 'uppercase'],
    ['numbers', 'numbers'],
    ['special', 'special'],
  ]) {
    if (args[key] === false) flags.push(`--no-${flag}`);
  }
  if (args.min_numbers !== undefined) {
    flags.push('--min-numbers', String(args.min_numbers));
  }
  if (args.min_special !== undefined) {
    flags.push('--min-special', String(args.min_special));
  }
  return flags;
}

/** @type {import('../rpc.js').ToolDef[]} */
export const generateTools = [
  {
    name: 'oneguard_generate',
    title: 'Generate a random value',
    description:
      'Generates one or more random values locally and returns them. Nothing is stored anywhere. ' +
      'Note that the returned value passes through this conversation — if the value is going into a OneGuard secret, use oneguard_secrets_generate instead, which stores it without ever revealing it.',
    inputSchema: object({
      ...GENERATOR_PROPS,
      count: {
        type: 'integer',
        description: 'How many values to generate. Default 1.',
        minimum: 1,
        maximum: 100,
      },
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(args) {
      const flags = generatorFlags(args);
      if (args.count !== undefined) {
        if (!Number.isInteger(args.count) || args.count < 1) {
          throw new ToolError('count must be a positive whole number.');
        }
        flags.push('--count', String(args.count));
      }
      // No API key needed: generation is entirely local, so this deliberately
      // does not go through runStructured (which would require a session).
      const out = await runCliChecked(['generate', ...flags]);
      const values = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      return { count: values.length, values };
    },
  },
  {
    name: 'oneguard_secrets_generate',
    title: 'Generate a value into a secret',
    description:
      'Generates a random value and stores it in a secret under the given key, WITHOUT returning the value. ' +
      'This merges: every other variable in the secret is preserved (unlike oneguard_secrets_edit, which replaces the whole payload). ' +
      'Use this whenever the user wants a new password, token or key created for a service — it is the safe path, because the value never enters this conversation. ' +
      'Fails if the key already exists unless force is true.',
    inputSchema: object(
      {
        vault: str('Vault id or its 8-character prefix.'),
        secret: str('Secret id or its 8-character prefix.'),
        key: str('The variable name to set, e.g. DB_PASSWORD.'),
        force: bool('Replace the key if it already exists. Default false.', false),
        ...GENERATOR_PROPS,
      },
      ['vault', 'secret', 'key'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async handler(args) {
      const vault = typeof args.vault === 'string' ? args.vault.trim() : '';
      const secret = typeof args.secret === 'string' ? args.secret.trim() : '';
      const key = typeof args.key === 'string' ? args.key.trim() : '';
      if (!vault || !secret || !key) {
        throw new ToolError('vault, secret and key are all required.');
      }

      const flags = generatorFlags(args);
      if (args.force === true) flags.push('--force');

      const { json, raw: out } = await runStructured([
        'secrets', 'generate',
        '--project', vault,
        '--id', secret,
        '--key', key,
        ...flags,
      ]);

      const total = out.match(/\((\d+) variables total\)/);
      return {
        stored: true,
        vault,
        secret,
        key,
        replaced: json?.replaced ?? /^Replaced/m.test(out),
        // Names only — the CLI never puts the generated value in its JSON
        // unless --show was passed, and this tool never passes it.
        variables: json?.variables,
        variable_count:
          json?.variable_count ?? (total ? Number(total[1]) : null),
        note: 'The generated value was stored and is intentionally not returned.',
        raw: out.trim(),
      };
    },
  },
];
