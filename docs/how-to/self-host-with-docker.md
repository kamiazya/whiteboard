# Self-hosted server-mode with Docker

This guide covers running whiteboard in **server mode** using the provided
`Dockerfile.server`. The container entrypoint runs `whiteboard server run --json`
and authenticates requests using JWT tokens issued by an external Identity
Provider (OAuth/JWT resource-server validation with external IdP). It is a
separate deployment path from the local daemon mode — do not mix local-daemon
tokens with server JWT authentication.

## Prerequisites

- Docker 20.10+ with Compose v2
- A TLS-terminating reverse proxy (nginx, Caddy, Traefik, …)
- An external IdP that exposes a JWKS endpoint over HTTPS

## Quick start

```sh
# 1. Copy the env template and fill in your values.
cp .env.server.example .env

# 2. Build and start the container.
docker compose -f docker-compose.server.yml up -d

# 3. Check the server is healthy.
docker compose -f docker-compose.server.yml ps
curl http://127.0.0.1:3099/api/runtime/ping
```

## Required environment variables

All six variables are required. The container will reject startup with a
non-zero exit code if any are missing or invalid.

| Variable | Description |
|---|---|
| `WHITEBOARD_SERVER_EXTERNAL_URL` | Public HTTPS URL that clients reach the server at. Must use `https://`. |
| `WHITEBOARD_SERVER_AUTH_STRATEGY` | Must be `oauth-jwt`. |
| `WHITEBOARD_SERVER_JWT_ISSUER` | Token issuer claim (`iss`) expected in every JWT. |
| `WHITEBOARD_SERVER_JWT_AUDIENCE` | Token audience claim (`aud`) expected in every JWT. |
| `WHITEBOARD_SERVER_JWKS_URI` | HTTPS URL of your IdP's JWKS endpoint. Must use `https://` with no credentials, query parameters, or URL fragments. |
| `WHITEBOARD_SERVER_ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins. Each entry must be an explicit `https://` origin **or** a `https://*.example.com` leftmost-label wildcard subdomain pattern (e.g. for Cloudflare Pages branch previews); bare `*` is never permitted. See [Configuration → Wildcard subdomain patterns](../reference/configuration.md#wildcard-subdomain-patterns). |

See `.env.server.example` for a filled-in template.

## Reverse proxy and TLS

The container binds plain HTTP on port 3099 (loopback only in the provided
Compose file: `127.0.0.1:3099:3099`). TLS termination is the responsibility of
the reverse proxy. Example nginx snippet:

```nginx
server {
    listen 443 ssl;
    server_name whiteboard.example.com;

    ssl_certificate     /etc/ssl/certs/whiteboard.crt;
    ssl_certificate_key /etc/ssl/private/whiteboard.key;

    location / {
        proxy_pass http://127.0.0.1:3099;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

If you place a proxy that sets `X-Forwarded-For`, also set
`WHITEBOARD_SERVER_TRUSTED_PROXY=true` so the server uses the forwarded IP for
access decisions.

## Persistent data volume

The container writes all data (SQLite database, server-mode record) under
`/data` (`WHITEBOARD_DATA_DIR`). Mount a named or bind-mount volume there to
survive container restarts:

```yaml
volumes:
  - whiteboard_data:/data
```

Data written to `/data` is owned by UID 1001 (`whiteboard` user). Ensure the
volume has the correct ownership if you pre-populate it.

## Healthcheck

The image configures a Docker healthcheck that polls
`/api/runtime/ping` every 30 s. This endpoint is public (no auth required)
and returns `{"ok":true,"instanceId":"<uuid>"}`. `instanceId` is a random
identifier generated fresh on every process start (not the OS pid — an OS
pid can be reused by an unrelated process, which would let a stale
record misidentify it as the daemon). It does not include any
configuration, credentials, or filesystem paths.

`whiteboard server doctor --json` is intentionally **not** used as the default
healthcheck because a transient IdP/JWKS outage would mark the container
unhealthy even while it continues to serve already-cached requests. Run doctor
separately when you need a full diagnostic:

```sh
docker exec <container> node dist/cli/index.js server doctor --json
```

The command reads all configuration from the environment variables already
present inside the container, so no flags need to be repeated on the host.

## Lifecycle management (status / stop / doctor)

Use the `whiteboard server` CLI commands to inspect or stop a running server.
Run them via `docker exec` so they share the same data directory:

```sh
# Check if the server process is running and its record is fresh.
docker exec <container> node dist/cli/index.js server status --json

# Gracefully stop the server process inside the container (sends SIGTERM,
# waits, escalates to SIGKILL if needed).
# Prefer `docker stop <container>` for normal container lifecycle.
docker exec <container> node dist/cli/index.js server stop --json
```

`docker stop` sends SIGTERM to the container's PID 1 (the server process) and
waits for it to exit cleanly. The server handles SIGTERM gracefully.

## Backup and restore

The `whiteboard server backup` and `whiteboard server restore` CLI commands
provide the operator-facing surface for data backup and restore.

**Constraints:**
- Stop the container before taking a backup. Never run backup against a live
  data volume — the CLI checks for a running `server-mode.json` record and
  refuses if the server process is still alive.
- Restore only into a missing or empty target directory. A non-empty target
  is rejected to prevent silent merging of stale state with the backup.
- After restore, `server-mode.json` is removed from the target. The
  restored server writes a fresh record on first start, so the source
  server's PID / port identity is never inherited.
- Raw JWT values, Authorization/Bearer headers, filesystem paths, and stack
  traces are never written to stdout, stderr, or the backup archive.

**Backup** — run host-side after stopping the container:

```sh
docker stop whiteboard-server

whiteboard server backup --json \
  --data-dir=/data/source \
  --output-dir=/data/backups/2025-01-01
```

Success: stdout contains `{"schemaVersion":1,"ok":true,"operation":"backup"}`,
stderr is empty, exit 0. On any error, stdout is empty, stderr carries a generic
safe message, exit 1.

**Restore** — into a fresh or empty target directory:

```sh
whiteboard server restore --json \
  --backup-dir=/data/backups/2025-01-01 \
  --target-dir=/data/restored
```

Success: stdout contains `{"schemaVersion":1,"ok":true,"operation":"restore"}`,
exit 0. The stale `server-mode.json` is removed from the restored tree
automatically; a fresh record is written when the new container starts.

Then start a new container pointing at the restored directory:

```sh
docker run --rm -d \
  -v /data/restored:/data \
  --env-file .env \
  whiteboard-server:latest
```

## Collecting a support bundle

`whiteboard server support-bundle` collects a redacted diagnostic snapshot and
writes it as a deterministic directory of JSON files. Use it to share
deployment state with maintainers without exposing credentials or raw paths.

**What the bundle contains:**

| File | Content |
|------|---------|
| `status.json` | Server running/stale/missing/malformed state, PID, port, authStrategy |
| `doctor.json` | Config, exposure, JWKS, data-dir, record, and runtime checks |
| `record.json` | Allow-listed server-mode record summary (publicBaseUrl → hostname only) |
| `manifest.json` | Bundle metadata: createdAt, packageVersion, platform, mode |

**What the bundle never contains:**

- Raw JWT values, Authorization/Bearer headers, JWKS URI credentials
- Absolute filesystem paths (raw dataDir, backup paths, internal bind URL)
- Stack traces or raw fs / network error messages
- `logs.jsonl` (no safe server-mode log source is available yet)

**Usage** — run via `docker exec` while the container is running or host-side
after stopping it:

```sh
# Collect a bundle into /data/bundles/2025-01-01 (output dir must not exist or be empty).
docker exec <container> node dist/cli/index.js server support-bundle \
  --json \
  --output-dir=/data/bundles/2025-01-01

# Or specify the data directory explicitly (host-side after stop):
whiteboard server support-bundle --json \
  --data-dir=/data \
  --output-dir=/tmp/bundle-2025-01-01
```

Success: stdout contains
`{"schemaVersion":1,"ok":true,"operation":"support-bundle","files":[...]}`,
stderr is empty, exit 0. On any error, stdout is empty, stderr carries a
generic safe message, exit 1.

The command can be run while the server is running (it does not stop the
server). It uses the current environment for server config, so JWKS
reachability and auth config checks in `doctor.json` reflect the live
deployment state.

## Release candidate verification

Run the Docker-specific gates before tagging a release that includes a new
image. These run in addition to — not instead of — the CI gates:

```sh
# Full Docker release verification (CI gates + Docker gates).
pnpm check:release-candidate:docker

# Or run the Docker-specific gates individually after check:release-candidate:
pnpm smoke:docker              # Docker image boots, serves MCP, auth smoke
pnpm smoke:docker-backup-restore  # backup → restore round-trip via volume mounts
```

The non-Docker release gates (unit tests, typecheck, distribution smokes,
etc.) are bundled in `pnpm check:release-candidate`. The Docker aggregate
runs CI gates first, then the two Docker-specific smokes:

```sh
pnpm check:release-candidate           # CI-equivalent gates (no Docker)
pnpm check:release-candidate:local     # above + mutation:contracts
pnpm check:release-candidate:docker    # CI gates + Docker gates (full docker release)
```

The machine-readable gate manifest lives at
`tests/e2e/distribution/release-gate-matrix.json`.

## Security notes

- The container runs as non-root user `whiteboard` (UID 1001).
- The container filesystem is read-only in the example Compose file; only
  `/data` (volume) and `/tmp` (tmpfs) are writable.
- No credentials are baked into the image. All `WHITEBOARD_SERVER_*` auth
  variables must be supplied at run time via `--env-file` or `-e`.
- The local-daemon token (`WHITEBOARD_DAEMON_TOKEN`) is not used in server
  mode and must not appear in the container environment.
- Raw JWT values, Authorization/Bearer headers, JWKS URI credentials, full
  filesystem paths, and stack traces are never written to stdout, stderr, or
  the Docker logs surface.
