import { READ_ONLY } from '../config.js';
import { authTools } from './auth.js';
import { envTools } from './env.js';
import { generateTools } from './generate.js';
import { orgTools } from './org.js';
import { secretTools } from './secrets.js';
import { vaultTools } from './vault.js';

/**
 * The full tool set, in the order a client will show them.
 *
 * @type {import('../rpc.js').ToolDef[]}
 */
const ALL_TOOLS = [
  ...authTools,
  ...envTools,
  ...vaultTools,
  ...secretTools,
  ...generateTools,
  ...orgTools,
];

/**
 * In read-only mode the mutating tools are not merely refused, they are never
 * advertised: a tool the model cannot see is a tool it cannot be talked into
 * calling. `oneguard_init` stays, since it only writes to this server's own
 * isolated credential store.
 *
 * `oneguard_generate` is marked read-only because it stores nothing — it is
 * pure local computation and reaches neither the network nor any secret.
 *
 * @returns {import('../rpc.js').ToolDef[]}
 */
export function buildToolset() {
  if (!READ_ONLY) return ALL_TOOLS;
  return ALL_TOOLS.filter(
    (t) => t.annotations?.readOnlyHint === true || t.name === 'oneguard_init',
  );
}
