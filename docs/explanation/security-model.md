# Security Model

This server is currently designed for local use first.

## Trust boundary

- The daemon binds to `127.0.0.1` (not `localhost`) by default, restricting access to the loopback interface.
- Mutating HTTP routes (`POST`, `PUT`, `DELETE` under `/api/*`) are protected with a local Bearer token when configured. Read-only `GET /api/*` routes are unauthenticated by design — they serve canvas metadata to the local browser without requiring credentials.
- The `/mcp` HTTP transport applies token checks and restricts the `Origin` header to loopback addresses (`127.0.0.1` or `::1`; bare `localhost` is not treated as equivalent).
- The packaged `stdio` MCP path does not use OAuth. Trust comes from the local process that launches the server.

## HTTP protections

- **Bearer token**: local HTTP clients must send `Authorization: Bearer <token>` when token auth is enabled. The token is stored in the daemon's HTML bootstrap payload only for the local browser session and is not persisted to disk in cleartext.
- **Origin checks**: `/mcp` only allows loopback browser origins (`127.0.0.1` or `::1`) for local HTTP use. `localhost` is not accepted as a loopback alias because browser policies treat it differently across platforms.
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
