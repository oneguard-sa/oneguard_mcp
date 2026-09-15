#!/usr/bin/env node
import { API_KEY, CLI_PATH, MCP_HOME, READ_ONLY } from './config.js';
import { log } from './logger.js';
import { McpStdioServer } from './rpc.js';
import { buildToolset } from './tools/index.js';

/**
 * Entry point. Speaks MCP over stdio, so the only thing that may ever reach
 * stdout is a JSON-RPC message — diagnostics go to stderr via log().
 */

const tools = buildToolset();

log(`cli=${CLI_PATH} home=${MCP_HOME} read_only=${READ_ONLY}`);
if (!API_KEY) {
  log(
    'ONEGUARD_API_KEY is not set — tools will report "not initialized" until oneguard_init is called.',
  );
}

const server = new McpStdioServer(tools);
server.start();

process.on('uncaughtException', (err) => {
  log(`uncaught: ${err?.stack || err}`);
});
process.on('unhandledRejection', (err) => {
  log(`unhandled rejection: ${err}`);
});
