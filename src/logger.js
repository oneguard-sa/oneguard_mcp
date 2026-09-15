/**
 * stdout belongs to the JSON-RPC transport. Anything written there that is not
 * a protocol message corrupts the stream and the client drops the connection,
 * so every diagnostic in this server goes to stderr — no exceptions.
 *
 * @param {...unknown} args
 */
export function log(...args) {
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  process.stderr.write(`[oneguard-mcp] ${line}\n`);
}
