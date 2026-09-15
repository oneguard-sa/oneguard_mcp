/**
 * Tiny helpers for hand-written JSON Schema, so tool definitions stay readable.
 */

/**
 * @param {Record<string, unknown>} properties
 * @param {string[]} [required]
 * @returns {Record<string, unknown>}
 */
export function object(properties, required = []) {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * @param {string} description
 * @param {{enum?: string[], default?: string}} [opts]
 */
export function str(description, opts = {}) {
  return {
    type: 'string',
    description,
    ...(opts.enum ? { enum: opts.enum } : {}),
    ...(opts.default !== undefined ? { default: opts.default } : {}),
  };
}

/**
 * @param {string} description
 * @param {boolean} [def]
 */
export function bool(description, def) {
  return {
    type: 'boolean',
    description,
    ...(def !== undefined ? { default: def } : {}),
  };
}

export const PROJECT_DIR = str(
  'Absolute path to the developer\'s project directory. This is where the .oneguard link file and the .env file live. Must be absolute — ask the user if you do not know it.',
);
