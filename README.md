# Weft

Weft is a local-first coordination, observability, and verification system for developers and coding agents working in the same repository. Agents keep running in their native tools; Weft collects their events, coordinates tasks and file reservations, detects overlap, manages task worktrees, and records validation evidence.

**Status:** unpublished source preview (`0.0.0`). There is no published npm package or registry image. Use a source checkout, a locally built daemon tarball, or the local Docker image described below.

## Architecture

| Component                   | Runs where                                   | Responsibilities                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Daemon (`weft`)             | Each developer machine                       | Authenticated local HTTP API, adapter translation, redaction, SQLite WAL store, durable outbox, file watching, symbol index, worktrees, conflict checks, validation, merge execution, MCP stdio bridge |
| Team server (`weft-server`) | One self-hosted host                         | Fastify API, Postgres migrations, idempotent ingest, task CAS, reservations, conflict cards, merge-queue leases, validation evidence, health baselines, RBAC/audit, SSE, notification webhooks         |
| Postgres 16                 | With the team server                         | Shared events, projections, credentials (hashed tokens), encrypted webhook secrets, and audit records                                                                                                  |
| UI                          | Vite dev server from this checkout           | Local view through the daemon proxy, or team view using a server URL, project ID, and bearer token                                                                                                     |
| Git origin                  | Your existing GitHub/GitLab/Gitea/other host | Branches and integration refs; daemons perform Git operations                                                                                                                                          |

In solo mode the daemon works offline and sends nothing to a team server. In team mode it batches redacted protocol events through a durable local outbox; the server deduplicates ingest and fans out team/coordination SSE. The current implementation does **not** upload source trees or diffs, run a server-side Git mirror, or execute checks on the server.

## Requirements

- Node.js 24 or newer and pnpm 11.25.0 for source development/packaging
- Git 2.38 or newer for `merge-tree` conflict and merge-queue support
- npm for installing the local daemon tarball
- Docker with Compose v2 for the team-server/Postgres stack

## Solo quickstart

From a source checkout:

```bash
pnpm install --frozen-lockfile
pnpm exec tsc -b apps/daemon/tsconfig.json
pnpm --filter @weft/daemon start
```

The daemon listens on `127.0.0.1:7421` and stores state under `.weft`. In another terminal:

```bash
node apps/daemon/dist/cli.js status
node apps/daemon/dist/cli.js repo add /absolute/path/to/repository
pnpm --filter @weft/ui dev
```

Open the Vite URL (normally `http://127.0.0.1:5173`). Stop with `node apps/daemon/dist/cli.js stop` or `Ctrl+C`. A repository must already be a Git clone. Validation has no checks until you configure them; see [Configuration](#configuration).

With an installed daemon, use `weft start`, `weft repo add ...`, `weft status`, and `weft stop` instead. The tarball contains the daemon/API and MCP bridge, **not** the browser UI; run the UI from a source checkout.

### MCP

Start the daemon first, then configure an MCP client to launch:

```json
{
  "mcpServers": {
    "weft": {
      "command": "weft",
      "args": ["mcp", "--data-dir", "/absolute/path/to/.weft"]
    }
  }
}
```

For a source checkout, replace `weft` with `node` and use the absolute path to `apps/daemon/dist/cli.js` as the first argument. The MCP process talks to the existing daemon; it does not open a second SQLite store. Provider hooks and push bridges still need to be wired to the daemon endpoints listed below; Weft does not install or launch provider agents.

## Team quickstart

1. Start Postgres and the team server with [docs/self-hosting.md](docs/self-hosting.md). The default published port is loopback-only.
2. Complete the documented one-time project/member/device bootstrap and issue a project-scoped token. There is currently no project-provisioning HTTP API.
3. Start each daemon with environment-only credentials:

   ```bash
   export WEFT_MODE=team
   export WEFT_SERVER_URL=http://127.0.0.1:7420
   export WEFT_PROJECT_ID=proj_...       # the ID created during bootstrap
   export WEFT_DEVICE_ID=dev_...        # this machine's registered ID
   export WEFT_SERVER_TOKEN=...         # keep in a secret manager/shell environment
   pnpm --filter @weft/daemon start
   ```

   Use `weft start` for an installed daemon. IDs use a prefix plus 26 Crockford Base32 characters. Do not commit tokens or put them in provider hook payloads.

4. Register repositories with `weft repo add`. Start the source-checkout UI and choose **Team** in connection settings; enter the server URL, project ID, and API token.

The server coordinates state but never runs Git or validation commands. A daemon with a merge-queue lease performs Git operations and another registered daemon must supply independent validation evidence for queue-gated completion. Solo validation is labeled self-validation.

## Adapters and fidelity

Adapters normalize provider data into protocol-v1 events. Fidelity describes what the adapter can observe; enforcement is a separate capability.

| Provider            | Transport / endpoint                            | Fidelity and limits                                                                  |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Claude Code         | Native hooks → `POST /v1/hooks/claude`          | High; synchronous PreToolUse is the only current hard-block boundary                 |
| Codex Hooks         | Native hooks → `POST /v1/hooks/codex`           | High telemetry, but provider failures are fail-open; reservations remain advisory    |
| Codex legacy notify | Command/HTTP bridge → `POST /v1/notify/codex`   | Low; turn-complete status only, no enforcement                                       |
| OpenCode            | SSE frames bridged to `POST /v1/opencode/event` | High after-the-fact telemetry; observe-only, no pre-tool blocking                    |
| Qoder               | Native hooks → `POST /v1/hooks/qoder`           | High telemetry; current response is advisory, not a provider-native deny contract    |
| Cursor              | Beta hooks → `POST /v1/hooks/cursor`            | Medium; fail-open, subagent/unknown hooks omitted, wire format needs re-verification |
| Cline               | SDK/OTel push → `POST /v1/cline/event`          | Medium; reported lifecycle/results only, observe-only                                |
| Generic CLI         | Wrapper events → `POST /v1/generic-cli/event`   | Low; process/command/file lifecycle, no tool transcript or enforcement               |
| Aider               | Wrap/poll events → `POST /v1/aider/event`       | Low; lifecycle, reported commits and file changes, observe-only                      |

Every `/v1/` daemon request except the loopback bootstrap endpoint requires the per-machine bearer secret. Do not assume an adapter sees full transcripts, subagents, or every edit. Check `GET /v1/adapters` for the runtime capability manifests.

## Configuration

Configuration precedence is CLI flags, then environment, then JSON file, then defaults. A minimal daemon file is:

```json
{
  "mode": "solo",
  "dataDir": ".weft",
  "privacy": { "syncScope": "metadata", "redactSecrets": true },
  "validation": {
    "timeoutMs": 120000,
    "checks": [{ "check_id": "unit", "command": "pnpm", "args": ["test"], "selection": "full" }]
  }
}
```

Pass it with `weft start --config /path/to/weft.json`. Checks are operator-authored local executable/argv pairs, run directly with `shell: false`, a scrubbed environment, timeouts, capped output, and redaction. They are never accepted from remote API requests.

Common environment settings:

| Variable                                                    | Purpose / default                                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `WEFT_DATA_DIR`                                             | State directory; `.weft`                                                                                             |
| `WEFT_MODE`                                                 | `solo` or `team`; `solo`                                                                                             |
| `WEFT_HOOK_HOST`, `WEFT_HOOK_PORT`                          | API bind; `127.0.0.1:7421`                                                                                           |
| `WEFT_SERVER_URL`                                           | Team server URL; unset                                                                                               |
| `WEFT_PROJECT_ID`, `WEFT_DEVICE_ID`                         | Registered team identities; generated locally if unset                                                               |
| `WEFT_SERVER_TOKEN`                                         | Project API token; unset                                                                                             |
| `WEFT_SYNC_SCOPE`                                           | Accepted values `metadata`, `diffs`, `full`; **leave at `metadata`** because only event/metadata sync is implemented |
| `WEFT_REDACT_SECRETS`                                       | Redact before persistence/broadcast; `true`                                                                          |
| `WEFT_GIT_BINARY`                                           | Git executable; `git`                                                                                                |
| `WEFT_VALIDATION_TIMEOUT_MS`, `WEFT_VALIDATION_CONCURRENCY` | Local check limits                                                                                                   |
| `WEFT_LOG_LEVEL`                                            | `trace`, `debug`, `info`, `warn`, `error`, or `fatal`; `info`                                                        |

The core config source defines additional retention, recap, and resolver settings. LLM recap is off by default. Server/Compose settings are in [docs/self-hosting.md](docs/self-hosting.md).

## Security model

- **Local-first:** solo mode does not require a server. Daemon APIs bind to loopback by default. Never expose the daemon directly to a network: its unauthenticated `/v1/bootstrap` returns the hook secret to a caller that can reach it.
- **Local credentials:** `.weft/identity.json` contains a generated hook secret and is created with owner-only permissions where supported. A process running as the same OS user can still read it; this is a documented residual risk.
- **Team authorization:** every `/v1/` server route requires a bearer credential. Project tokens are stored only as SHA-256 hashes, are revocable/expiring, and are constrained by project membership and viewer/member/admin scopes. Data queries are project-scoped; management actions and denials are audited.
- **Bootstrap admin:** the server generates a new admin secret at startup and stores it in the server state volume (`server.json`). Protect that volume and use the admin credential only to provision project tokens.
- **Redaction:** secret patterns/entropy redaction runs before event persistence and broadcast, and validation output is redacted. It is heuristic, not a guarantee against every secret or provider-specific encoding. Keep it enabled and review payloads before team use.
- **Webhooks:** per-webhook secrets are AES-256-GCM encrypted with project/id/version binding. `WEFT_SERVER_WEBHOOK_MASTER_KEY` is environment-only, is rejected from JSON config, and must be backed up securely. Private webhook endpoints are blocked by default.
- **No remote execution:** the server never executes Git, checks, or arbitrary commands. Validation runs only on a developer daemon using local operator configuration. Weft is not an agent sandbox; treat prompts, tool output, diffs, and agent-authored text as untrusted data.
- **Transport/browser:** the server does not terminate TLS. Use an authenticated TLS reverse proxy or SSH tunnel for remote access and restrict CORS. The team UI persists its bearer token in browser local storage; use a least-privilege token and avoid shared browsers.

## Local daemon tarball

`pnpm package:daemon` builds only the daemon and its workspace references, stages compiled internal packages under `node_modules/@weft`, rewrites `workspace:*` ranges to exact local versions, bundles those internal packages, hoists their external runtime dependencies into the daemon manifest, and creates a standard npm-compatible tarball:

```bash
pnpm install --frozen-lockfile
pnpm package:daemon
npm install --global ./dist/packages/weft-daemon-0.0.0.tgz
weft --help
```

The output is `dist/packages/weft-daemon-0.0.0.tgz`. This is a local distribution workflow, not a claim of npm registry availability. External dependencies are resolved by npm; the package includes no native binaries. A clean machine needs registry access (or a populated npm cache), and `better-sqlite3` may need a matching prebuild or native build tools. Optional `@parcel/watcher` support depends on the platform. The daemon package does not include the UI, team server, Docker image, or provider agents. Version `0.0.0` is a preview placeholder.

## Development checks

Use focused checks while iterating, especially on a busy machine:

```bash
pnpm exec tsc -b apps/daemon/tsconfig.json
pnpm exec vitest run apps/daemon/src/api.test.ts
node_modules/.bin/eslint scripts/package-daemon.mjs
node_modules/.bin/prettier --check README.md docs/self-hosting.md scripts/package-daemon.mjs docker-compose.yml package.json apps/daemon/package.json eslint.config.js
pnpm package:daemon
```

Maintainer checks are `pnpm typecheck`, `pnpm lint`, `pnpm test`, the `pnpm test:e2e*` scripts, and `pnpm check` (build + lint + unit tests). Validate Compose with `docker compose config --quiet` after supplying `POSTGRES_PASSWORD` in the environment. These commands are not evidence that performance gates or a 24-hour soak have passed.
