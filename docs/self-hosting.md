# Self-hosting the Weft team server

The root `Dockerfile` builds the **team server only**; `docker-compose.yml` adds Postgres 16. Daemons stay on developer machines. The image contains no Git executable, source checkout, UI bundle, or validation runner, so the server cannot execute Git or checks.

The build uses Node 24, the pinned pnpm version, `pnpm-lock.yaml`, a daemon-independent server TypeScript build, and `pnpm deploy --legacy --prod` for an isolated runtime tree. Nothing is published to a registry by these files.

## Start

Use Bash or an equivalent shell with a URL-safe database password supplied by your secret manager. A randomly generated hex password is suitable; do not commit it or put it in a tracked `.env` file.

```bash
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:7420/healthz
```

Persist `POSTGRES_PASSWORD` securely for future restarts. Losing it does not erase the database, but you will need a deliberate Postgres password-recovery procedure. Migrations apply automatically when the server starts.

- `server` is reachable only at `127.0.0.1:${WEFT_PORT:-7420}` by default.
- `db` publishes no host port; only the server can reach it on the Compose network.
- Named volumes `weft-postgres` and `weft-server` hold database and server state.
- Both services have healthchecks; the server waits for Postgres to become healthy.
- The server runs as `node` with a read-only root filesystem, dropped capabilities, and a writable state volume.

Useful operations:

```bash
docker compose logs -f server
docker compose restart server
docker compose down          # keeps both volumes
# docker compose down -v    # destructive: deletes the database and server state
```

Back up Postgres and protect the server-state volume before upgrades. `server.json` contains the current bootstrap admin secret. Treat runtime data and database dumps as sensitive even though API tokens are hashed and webhook secrets are encrypted.

## One-time project bootstrap

There is currently no HTTP API or CLI command to create organizations, teams, projects, users, or devices. On a fresh installation, an operator must seed those rows directly in Postgres. Run this once; the IDs below are not credentials and should be retained for daemon/UI configuration.

```bash
ORG_ID=$(docker compose exec -T server node --input-type=module -e "import {makeId} from '@weft/protocol'; console.log(makeId('organization'))")
TEAM_ID=$(docker compose exec -T server node --input-type=module -e "import {makeId} from '@weft/protocol'; console.log(makeId('team'))")
PROJECT_ID=$(docker compose exec -T server node --input-type=module -e "import {makeId} from '@weft/protocol'; console.log(makeId('project'))")
USER_ID=$(docker compose exec -T server node --input-type=module -e "import {makeId} from '@weft/protocol'; console.log(makeId('user'))")
DEVICE_ID=$(docker compose exec -T server node --input-type=module -e "import {makeId} from '@weft/protocol'; console.log(makeId('device'))")

docker compose exec -T db psql -U weft -d weft -v ON_ERROR_STOP=1 <<SQL
BEGIN;
INSERT INTO organizations (id, name, slug) VALUES ('$ORG_ID', 'Local organization', 'local');
INSERT INTO teams (id, org_id, name, slug) VALUES ('$TEAM_ID', '$ORG_ID', 'Local team', 'local');
INSERT INTO projects (id, team_id, name, slug) VALUES ('$PROJECT_ID', '$TEAM_ID', 'Local project', 'local');
INSERT INTO users (id, org_id, email, display_name)
  VALUES ('$USER_ID', '$ORG_ID', 'developer@example.invalid', 'Developer');
INSERT INTO memberships (user_id, team_id, role) VALUES ('$USER_ID', '$TEAM_ID', 'member');
INSERT INTO project_members (project_id, user_id, role) VALUES ('$PROJECT_ID', '$USER_ID', 'member');
INSERT INTO devices (id, user_id, hostname, os) VALUES ('$DEVICE_ID', '$USER_ID', 'developer-machine', 'local');
COMMIT;
SQL
```

Use distinct slugs for additional teams/projects. The SQL bootstrap is an explicit preview limitation, not a substitute for the server's RBAC/audit model on normal API operations.

## Issue a project token

Read the runtime-generated bootstrap secret without adding it to a file, then call the admin token endpoint. The raw project token is returned once; capture it in your shell/secret manager and do not paste it into committed configuration.

```bash
ADMIN_SECRET=$(docker compose exec -T server node -e "process.stdout.write(require('/var/lib/weft/server.json').admin_secret)")
TOKEN=$(curl -fsS -X POST http://127.0.0.1:7420/v1/admin/tokens \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"deviceId\":\"$DEVICE_ID\",\"role\":\"member\",\"name\":\"developer-machine\",\"expiresInDays\":90}" \
  | node -e "let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).token))")
unset ADMIN_SECRET
```

The bootstrap secret rotates on every server start; project tokens remain valid until expiry or revocation. Use viewer tokens for read-only UI users and separate device tokens for daemons. Revoke through `/v1/admin/tokens/:id/revoke?projectId=...`.

## Connect a daemon and UI

On each developer machine, using the installed daemon:

```bash
export WEFT_MODE=team
export WEFT_SERVER_URL=http://127.0.0.1:7420
export WEFT_PROJECT_ID="$PROJECT_ID"
export WEFT_DEVICE_ID="$DEVICE_ID"
export WEFT_SERVER_TOKEN="$TOKEN"
weft start
```

From a source checkout, use `pnpm --filter @weft/daemon start` instead. Register clones with `weft repo add /path/to/repo`. The UI is not served by the Docker image: run `pnpm --filter @weft/ui dev` from a checkout and connect in Team settings with the server URL, project ID, and token. The UI stores that token in browser local storage.

For remote access, prefer an SSH tunnel such as `ssh -L 7420:127.0.0.1:7420 user@server`. If you deliberately publish through a reverse proxy, terminate TLS there, restrict `WEFT_SERVER_CORS_ORIGIN` to the UI origin, and protect the host with network controls. Do not expose the developer daemon or its `/v1/bootstrap` endpoint.

## Environment reference

| Variable                         | Default / requirement                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`              | Required; URL-safe secret from the environment, no default                                |
| `WEFT_PORT`                      | Host port `7420`, bound to `127.0.0.1`                                                    |
| `WEFT_LOG_LEVEL`                 | `info`                                                                                    |
| `WEFT_SERVER_CORS_ORIGIN`        | `http://127.0.0.1:5173`; comma-separated allowlist for other UI origins                   |
| `WEFT_SERVER_WEBHOOKS_ENABLED`   | `false`                                                                                   |
| `WEFT_SERVER_WEBHOOK_MASTER_KEY` | Unset; required only when webhooks are enabled; exactly 32 bytes encoded as hex or base64 |

Webhook secrets are encrypted with AES-256-GCM. Supply the master key only through the environment/secret manager; JSON config cannot provide it. Generate a key with `openssl rand -hex 32` and back it up securely. Losing or changing it makes existing encrypted webhook secrets undecryptable. Private webhook targets remain blocked unless an operator explicitly sets `WEFT_SERVER_WEBHOOK_ALLOW_PRIVATE_ENDPOINTS=true` for a trusted network.

## Current boundaries

- Project provisioning requires the SQL bootstrap above.
- The Docker image serves the API/SSE, not the browser UI.
- Team sync is redacted event/metadata sync; `diffs`/`full` config values do not enable source upload or server-side analysis.
- The server records merge leases and validation evidence but never runs Git, checks, or remote commands.
- This is a local preview build, not a published image or a production upgrade/HA system. No performance or long-soak completion is implied.
