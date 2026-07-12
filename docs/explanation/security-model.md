# Security Model

Whiteboard runs in one of three runtimes, each with its own trust model:
**browser-local** (canvas data never leaves the browser's IndexedDB),
**local daemon** (loopback-only server for MCP/agent work, covered below),
and **server mode** (a shared server behind your own Identity Provider and
TLS, covered in its own section and in
[Self-host with Docker](../how-to/self-host-with-docker.md)). Do not read
one runtime's trust model as describing another — local-daemon tokens and
server-mode JWTs are separate credential systems and must never be mixed.

This page describes the **local daemon** in detail first, then server mode.

## Local daemon: trust boundary

- The daemon binds to `127.0.0.1` (not `localhost`) by default, restricting access to the loopback interface.
- HTTP routes under `/api/*` apply auth in two layers. First, a global middleware protects all mutation methods (`POST`, `PUT`, `PATCH`, `DELETE`) under `/api/*` except `/api/runtime/*`, which has its own per-router middleware. Second, `/api/runtime/*` routes — including read-only endpoints such as `GET /api/runtime/status` and `GET /api/runtime/storage` — require a Bearer token for every request except `/api/runtime/ping`, which is an unauthenticated liveness probe. Canvas and workspace `GET` routes outside `/api/runtime/` are unauthenticated in local-daemon mode and serve canvas metadata to the local browser without requiring credentials.
- The `/mcp` HTTP transport applies token checks and restricts the `Origin` header to loopback addresses (`127.0.0.1`, `::1`, or `localhost`).
- The packaged `stdio` MCP path does not use OAuth. Trust comes from the local process that launches the server.

## HTTP protections

- **Bearer token**: local HTTP clients must send `Authorization: Bearer <token>` when token auth is enabled. The token is written to `daemon.json` in the data directory (`~/.whiteboard` by default) so the stdio MCP server can locate the running daemon. The file is created with mode `0o600` (owner-read/write only) and is re-chmod'd after write on non-Windows platforms to counteract a permissive umask. Treat `daemon.json` as a credential file and ensure the data directory itself is not world-readable.
- **Origin checks**: `/mcp` only allows loopback browser origins (`127.0.0.1`, `::1`, or `localhost`) for local HTTP use. All three resolve to the same loopback interface; allowing `localhost` is consistent with browser behavior across platforms.
- **Hosted web-app pairing**: a browser app served from a non-loopback (hosted `https:`) origin can still pair with the local daemon, but only once that origin is listed in `WHITEBOARD_ALLOWED_WEB_ORIGINS` — a comma-separated, HTTPS-only allowlist whose entries are exact origins or `https://*.example.com` leftmost-label wildcard subdomain patterns (bare `*` is never permitted; see [Configuration → Wildcard subdomain patterns](../reference/configuration.md#wildcard-subdomain-patterns)). Loopback origins need no allowlist entry. This env var governs the local daemon only; it is unrelated to server mode's origin allowlist below.
- **Security headers**: the app serves `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and same-origin cross-origin headers.
- **Debug route gate**: `/api/debug` is hidden unless `WHITEBOARD_DEBUG=1` is set, and still requires Bearer auth when a token exists.

## File-system safety

- Runtime data is stored under `~/.whiteboard` by default.
- Canvas identifiers are validated before they are mapped to file paths.
- Export and upload flows stay within daemon-controlled storage paths unless explicitly extended.

## Browser-dependent operations

Some operations require a connected browser client.

- `viewport_set`
- `export_canvas({ format: "png" })`

These actions are routed through the daemon to the browser and fail fast when no browser client is connected.

## Server mode: trust boundary

Server mode (`whiteboard server run`, packaged as `Dockerfile.server` — see
[Self-host with Docker](../how-to/self-host-with-docker.md)) is a separate,
shipped deployment path for running whiteboard as a shared server beyond
loopback. It uses its own credential system — **never mix local-daemon
Bearer tokens with server-mode JWTs; they are not interchangeable.**

- Every request is authenticated with a JWT issued by an external Identity
  Provider (OAuth/JWT resource-server validation); the server itself does
  not issue or manage user credentials.
- Cross-origin access is restricted by `WHITEBOARD_SERVER_ALLOWED_ORIGINS`,
  an explicit `https://` allowlist (defaulting to
  `WHITEBOARD_SERVER_EXTERNAL_URL` when unset). Entries may be exact origins
  or a `https://*.example.com` leftmost-label wildcard subdomain pattern for
  deployment-preview shapes (e.g. Cloudflare Pages branch previews); bare `*`
  is always rejected. See
  [Configuration → Wildcard subdomain patterns](../reference/configuration.md#wildcard-subdomain-patterns)
  for the exact matching rules and the residual `*.pages.dev`-style breadth
  risk. This is a distinct setting from the local daemon's
  `WHITEBOARD_ALLOWED_WEB_ORIGINS` above; the two are read by different
  code paths and never consult each other.
- The container binds plain HTTP to **all interfaces (`0.0.0.0`) by
  default** (`WHITEBOARD_SERVER_HOST` overrides this); **TLS termination is
  the operator's responsibility**, done by a reverse proxy in front of the
  container (nginx, Caddy, Traefik, …). Mapping the port straight to a
  public interface exposes plain HTTP — server mode is not safe to expose
  directly to the internet without that proxy in place.
- Server mode is only as secure as its operator's configuration: a
  correctly configured Identity Provider, a correctly scoped origin
  allowlist, and TLS termination are all prerequisites the operator must
  provide — server mode does not ship "safe out of the box" without them.

## Current limitations

- Server mode is shipped and used today for team/remote deployments (see
  above); it is not itself production-hardened beyond what is documented on
  this page — treat it as "usable with a competent operator," not
  "zero-configuration safe."
- Storage quotas, telemetry policy, and remote threat-model docs are still
  separate follow-up items: this page describes trust boundaries and
  protections as implemented, not a vetted threat model for adversarial
  remote environments.
