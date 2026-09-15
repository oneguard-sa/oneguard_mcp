import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { log } from './logger.js';

/**
 * A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 on
 * stdin/stdout, implementing just the tools half of the protocol.
 *
 * Deliberately dependency-free. This server's whole job is to shell out to a
 * CLI, so the surface it needs from MCP is `initialize`, `tools/list` and
 * `tools/call` — a few dozen lines rather than a dependency tree.
 */

/** Protocol revisions we know how to speak, newest first. */
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * @typedef {object} ToolDef
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {Record<string, unknown>} inputSchema
 * @property {{readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean}} [annotations]
 * @property {(args: Record<string, any>) => Promise<unknown>} handler
 */

export class McpStdioServer {
  /** @param {ToolDef[]} tools */
  constructor(tools) {
    /** @type {Map<string, ToolDef>} */
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.buffer = '';
  }

  start() {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => this._onData(String(chunk)));
    process.stdin.on('end', () => process.exit(0));
    // A broken pipe on stdout means the client is gone; exit quietly rather
    // than crashing with an unhandled EPIPE.
    process.stdout.on('error', () => process.exit(0));
    log(`ready — ${this.tools.size} tools`);
  }

  /** @param {string} chunk */
  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      void this._handleLine(line);
    }
  }

  /** @param {string} line */
  async _handleLine(line) {
    /** @type {any} */
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this._send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    // Responses to requests we never send, and notifications, get no reply.
    if (msg.method === undefined) return;
    const isNotification = msg.id === undefined || msg.id === null;

    try {
      const result = await this._dispatch(msg.method, msg.params ?? {});
      if (result === undefined) return; // notification handled
      if (!isNotification) {
        this._send({ jsonrpc: '2.0', id: msg.id, result });
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      log(`error in ${msg.method}: ${e?.message ?? e}`);
      if (!isNotification) {
        this._send({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: typeof e?.code === 'number' ? e.code : -32603,
            message: String(e?.message ?? 'Internal error'),
          },
        });
      }
    }
  }

  /**
   * @param {string} method
   * @param {any} params
   * @returns {Promise<any>}
   */
  async _dispatch(method, params) {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOLS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;

      case 'ping':
        return {};

      case 'tools/list':
        return {
          tools: [...this.tools.values()].map((t) => ({
            name: t.name,
            title: t.title,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        };

      case 'tools/call':
        return await this._callTool(params);

      default: {
        const err = /** @type {any} */ (
          new Error(`Method not found: ${method}`)
        );
        err.code = -32601;
        throw err;
      }
    }
  }

  /** @param {any} params */
  async _callTool(params) {
    const name = params?.name;
    const tool = this.tools.get(name);
    if (!tool) {
      const err = /** @type {any} */ (new Error(`Unknown tool: ${name}`));
      err.code = -32602;
      throw err;
    }

    try {
      const payload = await tool.handler(params?.arguments ?? {});
      return {
        content: [
          { type: 'text', text: JSON.stringify(payload, null, 2) },
        ],
      };
    } catch (err) {
      // A tool that fails is not a protocol failure: report it inside the
      // result so the model can read the message and correct itself.
      const e = /** @type {any} */ (err);
      log(`tool ${name} failed: ${e?.message ?? e}`);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { error: String(e?.message ?? 'Tool failed') },
              null,
              2,
            ),
          },
        ],
      };
    }
  }

  /** @param {object} msg */
  _send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  }
}
