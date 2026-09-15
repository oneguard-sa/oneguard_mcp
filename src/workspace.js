import fs from 'node:fs';
import path from 'node:path';

import { ToolError } from './cli.js';

/**
 * Everything that touches the user's working directory: the CLI's per-project
 * link file (`.oneguard`) and the generated `.env`.
 *
 * The MCP server runs from an arbitrary cwd (the client chooses it), so no tool
 * here ever relies on `process.cwd()` — the directory is always an explicit,
 * absolute argument.
 */

const LINK_FILE = '.oneguard';

/**
 * @param {unknown} dir
 * @returns {string}
 */
export function requireProjectDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new ToolError('project_dir is required.');
  }
  if (!path.isAbsolute(dir)) {
    throw new ToolError(
      `project_dir must be an absolute path (got "${dir}"). This server runs outside your shell, so relative paths are meaningless here.`,
    );
  }
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new ToolError(`Directory not found: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new ToolError(`Not a directory: ${dir}`);
  }
  return dir;
}

/**
 * Reads the CLI's `.oneguard` link file, which records which remote secret this
 * directory is synced to. Same shape the CLI writes, so a directory linked here
 * keeps working with plain `oneguard env sync` in a terminal, and vice versa.
 *
 * @param {string} dir
 * @returns {{project_id?: string, secret_id?: string}}
 */
export function readLink(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, LINK_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} dir
 * @param {string} projectId
 * @param {string} secretId
 */
export function writeLink(dir, projectId, secretId) {
  const file = path.join(dir, LINK_FILE);
  const existing = readLink(dir);
  const next = { ...existing, project_id: projectId, secret_id: secretId };
  fs.writeFileSync(file, JSON.stringify(next), 'utf8');
}

/**
 * @param {string} dir
 * @returns {boolean} whether a link file was removed
 */
export function clearLink(dir) {
  const file = path.join(dir, LINK_FILE);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/**
 * Resolves the env file path a tool was asked to write, and refuses to escape
 * the project directory.
 *
 * @param {string} dir
 * @param {string|undefined} relOrAbs
 * @returns {string} absolute path
 */
export function resolveEnvPath(dir, relOrAbs) {
  const target = path.resolve(dir, relOrAbs && relOrAbs.length > 0 ? relOrAbs : '.env');
  const rel = path.relative(dir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolError(
      `The env file path must stay inside project_dir. "${relOrAbs}" resolves outside ${dir}.`,
    );
  }
  return target;
}

/**
 * Reads the KEY names out of a .env file.
 *
 * Only names are ever returned. The values are the whole point of this product
 * being a secrets manager — they land on disk for the developer's tooling and
 * must not travel back through the model's context.
 *
 * @param {string} file
 * @returns {string[]}
 */
export function readEnvKeys(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  /** @type {string[]} */
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    keys.push(trimmed.slice(0, eq).trim());
  }
  return keys;
}

/**
 * @param {string} file
 * @returns {boolean}
 */
export function fileExists(file) {
  return fs.existsSync(file);
}
