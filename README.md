# oneguard-mcp

An [MCP](https://modelcontextprotocol.io) server that puts the [OneGuard](https://oneguard.one) CLI in front of an AI agent — Claude Code, Claude Desktop, Cursor, or anything else that speaks MCP over stdio.

Ask your agent to sync a project's secrets into `.env`, rotate a database password without ever seeing it, or check who changed a secret last week.

```
You:    sync this folder's secrets from OneGuard
Claude: Which vault? → api-production · marketing-site
You:    api-production
Claude: Wrote 12 variables to .env — DATABASE_URL, API_TOKEN, STRIPE_KEY, …
```

It shells out to the `oneguard` binary you already have installed. No new backend, no second login, no API surface of its own: whatever the CLI can do, this exposes, and whatever it cannot, this does not pretend to.

- **Zero dependencies.** The MCP stdio protocol is implemented directly. Nothing to install, nothing to build, no dependency tree to audit — the whole server is the files in `src/`.
- **Secret values do not come back.** Tools report variable *names* and counts. Values are written to and read from your `.env` by the CLI itself and never enter the model's context.
- **Isolated credentials.** The agent's session never touches your own `oneguard auth login`.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- The `oneguard` CLI **1.2.0 or newer** — [installation](https://oneguard.one/docs/getting-started/)
- A OneGuard API key (dashboard → **Vault → API Keys → Add**)

## Install

**Claude Code**

```bash
claude mcp add oneguard -s user \
  --env ONEGUARD_API_KEY=og_your_key \
  -- npx -y github:oneguard-sa/oneguard_mcp#v0.3.0
```

**Claude Desktop** (`claude_desktop_config.json`) **or Cursor** (`mcp.json`)

```json
{
  "mcpServers": {
    "oneguard": {
      "command": "npx",
      "args": ["-y", "github:oneguard-sa/oneguard_mcp#v0.3.0"],
      "env": {
        "ONEGUARD_API_KEY": "og_your_key"
      }
    }
  }
}
```

Then ask the agent *"what's my OneGuard connection status?"* to confirm it is wired up.

**Pin the tag.** `#v0.3.0` is not decoration: without it you run whatever is on
`main` at that moment, so a push here would execute on your machine without you
choosing to update. Bump the tag deliberately, after reading the
[release notes](https://github.com/oneguard-sa/oneguard_mcp/releases).

**Or clone it once.** `npx` re-resolves this repository every time an MCP server
starts, which adds a few seconds to each session. A local clone is the fastest
option and works offline:

```bash
git clone --branch v0.3.0 https://github.com/oneguard-sa/oneguard_mcp.git ~/tools/oneguard-mcp

claude mcp add oneguard -s user \
  --env ONEGUARD_API_KEY=og_your_key \
  -- node ~/tools/oneguard-mcp/src/index.js
```

Update with `git fetch --tags && git checkout <new tag>`.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ONEGUARD_API_KEY` | — | Initializes the session on the first tool call. Without it, the agent must call `oneguard_init` with a key you supply. |
| `ONEGUARD_CLI_PATH` | `oneguard` | Absolute path to the binary, when it is not on `PATH`. |
| `ONEGUARD_MCP_HOME` | `~/.oneguard-mcp` | Isolated credential store for the agent's session. |
| `ONEGUARD_MCP_READONLY` | `false` | `1` hides every mutating tool. |
| `ONEGUARD_MCP_TIMEOUT_MS` | `60000` | Per-command timeout. |

## Tools

| Tool | What it does |
| --- | --- |
| `oneguard_env_sync` | **The main one.** Pulls the linked secret into the directory's `.env`, linking it the first time. |
| `oneguard_env_push` | Uploads the local `.env` back into the linked secret, replacing it. |
| `oneguard_env_status` | Is this directory linked, to what, and which variable names are in its `.env`. |
| `oneguard_env_unlink` | Removes the `.oneguard` link file; leaves `.env` alone. |
| `oneguard_generate` | Generates a random value locally and returns it. Stores nothing. |
| `oneguard_secrets_generate` | Generates a value **into** a secret, merging, without revealing it. |
| `oneguard_vault_list` / `_add` / `_rename` | Vaults. |
| `oneguard_secrets_list` / `_add` / `_edit` / `_archive` / `_delete` | Secrets. |
| `oneguard_teams_list` / `_invite` / `_set_role` / `_remove` | Members, invitations and roles. |
| `oneguard_logs_list` | Organization audit log. |
| `oneguard_status` / `oneguard_init` | Connection and session. |

## How it handles secrets

This server sits between a secrets manager and a language model, so the interesting part is what it refuses to do.

**Values are not returned.** `oneguard_env_sync` and `oneguard_env_push` report variable names and a count. The CLI decrypts to disk; nothing in the tool result carries a value. There is a test that asserts this.

**Generating a credential never reveals it.** `oneguard_secrets_generate` has the CLI generate the value and store it directly, merging into the secret so every other variable survives. The agent learns that `DB_PASSWORD` now exists, and nothing more. `oneguard_generate` is the one tool that returns a value — a value stored nowhere is useless unless returned — and its description steers the model to the other tool whenever the value is destined for a secret.

**Your login is not the agent's login.** The CLI keeps its key in `$HOME/.oneguard/credentials.json`, one file for every copy of the CLI on the machine. This server hands each subprocess its own `HOME`, so an agent session cannot overwrite the key you use in your terminal — and a rejected key here cannot sign you out there.

**Destructive tools ask for proof.** Deleting a secret requires its exact name; removing a member requires their exact email. Both are checked against the server before anything happens, so an agent working from a half-remembered name is stopped rather than guessing.

**Two independent brakes.** An API key created as `read` is refused every write by the server, whatever the client does. `ONEGUARD_MCP_READONLY=1` additionally hides the mutating tools so the model never sees them. Use the key for the guarantee, the flag to keep the tool list focused; `oneguard_status` reports `can_write` so the agent knows which it has before it tries.

**Interactive commands are never invoked.** `oneguard env sync` on an unlinked directory prompts on stdin, which cannot work when no human is on the other end of the pipe. Instead this server returns the list of vaults for *you* to choose from, writes the `.oneguard` link itself, then calls the non-interactive `env pull`. Subprocess stdin is closed, so anything that tries to prompt fails fast instead of hanging.

The link file is byte-compatible with the CLI's own, so a directory linked by the agent keeps working with `oneguard env sync` in your terminal, and the other way round.

## Development

```bash
git clone https://github.com/oneguard-sa/oneguard_mcp.git
cd oneguard_mcp
node test/smoke.test.js
```

No install step — there are no dependencies. The suite drives the real server over stdio against a mock CLI that reproduces the real binary's output formatting and exit codes: the protocol handshake, the full sync flow, generation, team management, the read-only key path, and the guardrails. 39 checks, no network and no OneGuard account needed.

Against a real account, read-only:

```bash
ONEGUARD_API_KEY=og_your_key node test/live-check.js
```

### A note on parsing

The OneGuard CLI prints for humans — there is no `--json` mode yet — so [`src/parsers.js`](src/parsers.js) turns lines like `ID: 84e1d2b3 | Name: production | Archived: false` back into objects. Every parser is tolerant of unrecognized lines and every tool also returns the raw stdout, so a formatting change in the CLI degrades rather than breaks.

That file is the seam between the two projects. If the CLI's output changes, `live-check.js` is the fastest way to notice, and `src/parsers.js` should be the only file that needs updating.

## Releasing

This server is installed straight from this repository, so a release is a tag
and a set of release notes — there is no registry in the loop.

```bash
npm version minor --no-git-tag-version   # bump package.json only
git commit -am "0.4.0"
git tag v0.4.0
git push && git push --tags
```

The tag triggers `.github/workflows/publish.yml`, which runs the test suite,
checks the tag matches `package.json`, and publishes a GitHub Release. Anyone
pinned to an older tag keeps running it until they change the pin.

Publishing to npm later would not change how any of this works — the package is
already shaped for it — but nothing here depends on it.

## License

MIT — see [LICENSE](LICENSE).
