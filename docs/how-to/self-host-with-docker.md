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

# 2. Build and start the container. NODE_VERSION is a required build
#    argument — the image pins the same Node release the repo develops on.
NODE_VERSION="$(cat .node-version)" docker compose -f docker-compose.server.yml up -d --build

# 3. Check the server is healthy.
docker compose -f docker-compose.server.yml ps
curl http://127.0.0.1:3099/api/runtime/ping
```

## Required environment variables

All five variables are required. The container will reject startup with a
non-zero exit code if any are missing or invalid.

| Variable | Description |
|---|---|
| `WHITEBOARD_SERVER_EXTERNAL_URL` | Public HTTPS URL that clients reach the server at. Must use `https://`. |
| `WHITEBOARD_SERVER_AUTH_STRATEGY` | Must be `oauth-jwt`. |
| `WHITEBOARD_SERVER_JWT_ISSUER` | Token issuer claim (`iss`) expected in every JWT. |
| `WHITEBOARD_SERVER_JWT_AUDIENCE` | Token audience claim (`aud`) expected in every JWT. |
| `WHITEBOARD_SERVER_JWKS_URI` | HTTPS URL of your IdP's JWKS endpoint. Must use `https://` with no credentials, query parameters, or URL fragments. |

### Optional

| Variable | Description |
|---|---|
| `WHITEBOARD_SERVER_ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins. Defaults to `WHITEBOARD_SERVER_EXTERNAL_URL` when unset. Each entry must be an explicit `https://` origin **or** a `https://*.example.com` leftmost-label wildcard subdomain pattern (e.g. for Cloudflare Pages branch previews); bare `*` is never permitted. See [Configuration → Wildcard subdomain patterns](../reference/configuration.md#wildcard-subdomain-patterns). |
| `WHITEBOARD_SERVER_JWT_ALLOW_UNTYPED_ACCESS_TOKENS` | `true`/`false` (default `false`). By default the server rejects a JWT that doesn't self-identify as an access token (RFC 9068 `typ: at+jwt` header or `token_use: access` claim), to stop an ID token from the same IdP being replayed as an access token. Set `true` only if your IdP's access tokens carry neither discriminator. See [Security model](../explanation/security-model.md#server-mode-trust-boundary). |

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

**You can have this handled rather than remembered.** Set
`WHITEBOARD_BACKUP_DIR` to an absolute path on a volume that is not the data
volume, and the daemon takes a backup on a schedule — the same pass
`whiteboard server backup` runs, into one timestamped directory per run, with
`WHITEBOARD_BACKUP_KEEP` older ones retained.

`WHITEBOARD_BACKUP_CRON` puts it in a window you choose (default `0 3 * * *`,
daily at 03:00). Whose 03:00 is your container's own clock — set `TZ` (or
Compose's `environment: [TZ=Asia/Tokyo]`) and the schedule follows it along
with every timestamp in your logs. A container with no `TZ` runs on UTC, so
the quiet hour you picked may be someone else's afternoon.
`WHITEBOARD_BACKUP_TZ` overrides the zone for this schedule alone, for when
backups should run on a different clock from the rest of the deployment. The
daemon logs the zone it resolved and the exact instant the next pass falls on
when it starts, so you can check which 03:00 you got rather than infer it. A
backup is a database snapshot plus a copy of every blob, so putting it where
the load is low is worth the setting. The explicit command keeps its
value for a migration, a support copy, or a snapshot before a risky change,
but it stops being the only way anything gets backed up. A backup you have to
remember to take is one taken rarely or never, and the interval between
backups is the data you lose.

Setting an interval or a retention count WITHOUT a destination aborts startup:
that combination configures nothing while looking exactly like one that works.

The pass runs as a child process rather than inside the daemon, so the
snapshot step does not stall the server that is answering your requests. You
will see a second short-lived `whiteboard` process while a backup runs; that
is expected.

**Running more than one instance changes nothing about how you configure
this.** Set the same variables on every instance; they agree among themselves
through a lease row in the database they already share, so one instance takes
each night's backup and the rest stand down. That matters more under cron than
it would under an interval — an interval drifts apart from each container's own
restart, while `0 3 * * *` fires on all of them in the same minute. Retention
runs inside the same lease, because N instances pruning independently would
each be deleting from a set the others are changing. An instance that cannot
reach the shared database skips the pass rather than assuming it is alone.

**Constraints:**
- **You no longer need to stop the container to take a backup.** The rows are
  captured through the database rather than by reading its files, every write
  into the data directory lands atomically, and file-GC stands down for the
  duration — so a backup taken while the server serves is a consistent one.
  A backup that requires downtime is one you take rarely or never, and the
  interval between backups is the data you lose.

  `restore` still requires the target to be stopped and empty: it is putting
  a whole data directory back, not reading one.
- **A backup never carries `daemon.json`.** That file holds the Bearer token
  the daemon authenticates HTTP and WS with, and is written owner-only for
  that reason. A backup directory is the opposite of owner-only, so it is
  excluded — along with the staging directory for in-flight writes and the
  backup's own progress marker. A restored deployment writes a fresh daemon
  record on first start.

- **The data directory holds three database files, not one.** The database
  runs in WAL mode, so `whiteboard.db` is accompanied by `whiteboard.db-wal`
  and `whiteboard.db-shm`. They are one artifact: the newest commits live in
  the `-wal` until a checkpoint folds them back, so copying `whiteboard.db`
  on its own silently loses recent writes. `backup` copies the directory and
  takes all three; if you ever copy by hand, take all three too.

  WAL is what lets a backup read the database without stopping the daemon
  from serving — under SQLite's default journal a read in progress blocks
  writes outright.

  A backup DIRECTORY holds only one, though. The rows are captured through
  the database (`VACUUM INTO`), not by copying its files, so the result is a
  single self-contained `whiteboard.db` with the write-ahead log already
  folded in. Nothing reading a backup has to know sidecars exist.

- **These commands answer per store, not with one boolean.** They copy a
  directory, so they capture the database only while it *is* a file in that
  directory. If you have set
  [`WHITEBOARD_DATABASE_URL`](../reference/configuration.md) to a libSQL
  server, the backup still runs and still saves your blobs — which nothing
  else is saving — and reports the database as out of scope:

  ```json
  {"schemaVersion":2,"ok":true,"operation":"backup",
   "stores":{"database":{"captured":false,"reason":"hosted-elsewhere"},
             "blobs":{"captured":true}}}
  ```

  A note naming what is now yours to arrange goes to stderr, so stdout stays
  parseable. Back that database up where it lives, using the facilities of
  whatever hosts it — its operator already has point-in-time recovery and a
  retention policy, and duplicating those badly would be worse than not
  duplicating them.

  `ok` says the operation did what it is responsible for. It does not say the
  backup is complete; `stores` says that.
- **The refusal does not depend on this shell's environment.** These commands
  run host-side, where the container's `--env-file` is not loaded, so
  `WHITEBOARD_DATABASE_URL` is usually absent here even when the deployment
  sets it. Both commands therefore also check the directory itself: one with
  no `whiteboard.db` in it is refused, because a copy of it cannot carry rows
  no matter what any environment says.
- **A stale `whiteboard.db` is never copied, thanks to a record the server
  leaves behind.** If you once ran with the embedded database, later pointed
  `WHITEBOARD_DATABASE_URL` at a libSQL server, and left the old file in the
  data directory, neither of the checks above can see it: the environment is
  this shell's, and a directory cannot tell a live database from a fossil. So
  the server writes `storage.json` in the data directory each time it opens
  its database, recording whether the rows are in the directory, and `backup`
  reads it first. It is deliberately never deleted — being readable after the
  server is stopped is the whole point — and it holds no connection string. A
  data directory that predates this file, or one no server has ever opened,
  falls back to the environment-and-directory checks above. The fossil is then
  left OUT of the copy, rather than the whole backup being refused.

  `restore` reads the same record, but from the BACKUP directory rather than
  the target — a backup carries the copy taken from its source. That is how a
  legitimately rows-less backup is told apart from a truncated one, and how a
  fossil that reached a backup by an operator's own `cp -r` is recognised as
  supplying nothing. The target never has a record of its own to read: restore
  only ever writes into an empty or missing directory.
- Restore only into a missing or empty target directory. A non-empty target
  is rejected to prevent silent merging of stale state with the backup.
- **A backup must supply exactly the rows its target expects.** Restoring a
  rows-less backup into a deployment that keeps its rows in the data directory
  would leave a server pointed at nothing, and restoring rows into one reading
  libSQL would write a file nobody opens. Both are refused rather than
  half-performed: restoring *across* a configuration change is a real need and
  is not yet answered.
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
