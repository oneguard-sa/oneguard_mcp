/**
 * The OneGuard CLI prints for humans, not for machines: no --json flag yet.
 * Everything here turns those lines back into structured data.
 *
 * Every parser is tolerant by design — an unrecognized line is skipped rather
 * than throwing — and every tool that uses one also returns the raw stdout, so
 * a formatting change degrades to "the agent still sees the text" instead of
 * "the tool breaks". When the CLI grows a real `--json` mode, this file is the
 * only thing that should have to change.
 */

/** @param {string} out */
function lines(out) {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * `ID: 0d8ac74c | Name: my-project`
 * @param {string} out
 * @returns {{id: string, name: string}[]}
 */
export function parseProjects(out) {
  /** @type {{id: string, name: string}[]} */
  const rows = [];
  for (const line of lines(out)) {
    const m = line.match(/^ID:\s*(\S+)\s*\|\s*Name:\s*(.+)$/);
    if (m) rows.push({ id: m[1], name: m[2].trim() });
  }
  return rows;
}

/**
 * `ID: 84e1d2b3 | Name: production | Archived: false`
 * @param {string} out
 * @returns {{id: string, name: string, archived: boolean}[]}
 */
export function parseSecrets(out) {
  /** @type {{id: string, name: string, archived: boolean}[]} */
  const rows = [];
  for (const line of lines(out)) {
    const m = line.match(
      /^ID:\s*(\S+)\s*\|\s*Name:\s*(.+?)\s*\|\s*Archived:\s*(true|false)$/i,
    );
    if (m) {
      rows.push({
        id: m[1],
        name: m[2].trim(),
        archived: m[3].toLowerCase() === 'true',
      });
    }
  }
  return rows;
}

/**
 * `ID: 12ab34cd | Email: a@b.com | Role: admin`
 * @param {string} out
 * @returns {{id: string, email: string, role: string}[]}
 */
export function parseTeams(out) {
  /** @type {{id: string, email: string, role: string}[]} */
  const rows = [];
  for (const line of lines(out)) {
    const m = line.match(
      /^ID:\s*(\S+)\s*\|\s*Email:\s*(\S+)\s*\|\s*Role:\s*(\S+)$/,
    );
    if (m) rows.push({ id: m[1], email: m[2], role: m[3] });
  }
  return rows;
}

/**
 * `[2026-09-06 10:00:00.000] [create] Mohmad: project/abc`
 * @param {string} out
 * @returns {{time: string, action: string, user: string, resource: string}[]}
 */
export function parseLogs(out) {
  /** @type {{time: string, action: string, user: string, resource: string}[]} */
  const rows = [];
  for (const line of lines(out)) {
    const m = line.match(/^\[(.+?)\]\s*\[(.+?)\]\s*(.+?):\s*(.*)$/);
    if (m) {
      rows.push({
        time: m[1],
        action: m[2],
        user: m[3].trim(),
        resource: m[4].trim(),
      });
    }
  }
  return rows;
}

/**
 * `Project created successfully with ID: 0d8ac74c-d560-...`
 * @param {string} out
 * @returns {string|null}
 */
export function parseCreatedId(out) {
  const m = out.match(/with ID:\s*(\S+)/i);
  return m ? m[1] : null;
}

/**
 * Pulls the org id out of `oneguard status` output.
 * @param {string} out
 * @returns {string|null}
 */
export function parseOrgId(out) {
  const m = out.match(/Org ID:\s*([0-9a-fA-F-]+)/);
  return m ? m[1] : null;
}

/**
 * Pulls the API key's permission out of `oneguard status` output.
 * @param {string} out
 * @returns {'read'|'write'|null}
 */
export function parseKeyPermission(out) {
  const m = out.match(/Permission:\s*(read|write)\b/i);
  return m ? /** @type {'read'|'write'} */ (m[1].toLowerCase()) : null;
}

/**
 * Matches a full id or an 8-char prefix against a list of rows.
 *
 * The CLI prints ids truncated to 8 characters but accepts a prefix wherever it
 * accepts an id, so the short form the agent saw in a listing is a valid
 * argument — this just resolves it back to a row when we need its name.
 *
 * @template {{id: string}} T
 * @param {T[]} rows
 * @param {string} idOrPrefix
 * @returns {T|undefined}
 */
export function findByIdPrefix(rows, idOrPrefix) {
  const needle = idOrPrefix.toLowerCase();
  return rows.find((r) => {
    const id = r.id.toLowerCase();
    return id === needle || id.startsWith(needle) || needle.startsWith(id);
  });
}
