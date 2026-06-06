# Security Model

This server is currently designed for local use first.

## Trust boundary

- The daemon binds to `127.0.0.1` (not `localhost`) by default, restricting access to the loopback interface.
- HTTP routes under `/api/*` apply auth in two layers. First, a global middleware protects all mutation methods (`POST`, `PUT`, `PATCH`, `DELETE`) under `/api/*` except `/api/runtime/*`, which has its own per-router middleware. Second, `/api/runtime/*` routes — including read-only endpoints such as `GET /api/runtime/status` and `GET /api/runtime/storage` — require a Bearer token for every request except `/api/runtime/ping`, which is an unauthenticated liveness probe. Canvas and workspace `GET` routes outside `/api/runtime/` are unauthenticated in local-daemon mode and serve canvas metadata to the local browser without requiring credentials.
- The `/mcp` HTTP transport applies token checks and restricts the `Origin` header to loopback addresses (`127.0.0.1`, `::1`, or `localhost`).
- The packaged `stdio` MCP path does not use OAuth. Trust comes from the local process that launches the server.

## HTTP protections

- **Bearer token**: local HTTP clients must send `Authorization: Bearer <token>` when token auth is enabled. The token is written to `daemon.json` in the data directory (`~/.whiteboard` by default) so the stdio MCP server can locate the running daemon. The file is created with mode `0o600` (owner-read/write only) and is re-chmod'd after write on non-Windows platforms to counteract a permissive umask. Treat `daemon.json` as a credential file and ensure the data directory itself is not world-readable.
- **Origin checks**: `/mcp` only allows loopback browser origins (`127.0.0.1`, `::1`, or `localhost`) for local HTTP use. All three resolve to the same loopback interface; allowing `localhost` is consistent with browser behavior across platforms.
- **Security headers**: the app serves `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and same-origin cross-origin headers.
- **Debug route gate**: `/api/debug` is hidden unless `WHITEBOARD_DEBUG=1` is set, and still requires Bearer auth when a token exists.

## File-system safety

- Runtime data is stored under `~/.whiteboard` by default.
- Canvas identifiers are validated before they are mapped to file paths.
- Export and upload flows stay within daemon-controlled storage paths unless explicitly extended.

## Browser-dependent operations

Some operations require a connected browser client.

- `viewport_set`
- `export_png`

These actions are routed through the daemon to the browser and fail fast when no browser client is connected.

## Current limitations

- The project is local-first, not a fully productized remote MCP deployment.
- OAuth 2.1 metadata plumbing exists for future remote readiness, but the default trust model is still local loopback plus Bearer token.
- Storage quotas, telemetry policy, and remote threat-model docs are still separate follow-up items.
