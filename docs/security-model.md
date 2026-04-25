# Security Model

This server is currently designed for local use first.

## Trust boundary

- The daemon binds to `127.0.0.1` by default.
- Mutating HTTP routes are protected with a local Bearer token when configured.
- The `/mcp` HTTP transport also applies token checks and loopback-origin validation.
- The packaged `stdio` MCP path does not use OAuth. Trust comes from the local process that launches the server.

## HTTP protections

- **Bearer token**: local HTTP clients must send `Authorization: Bearer <token>` when token auth is enabled.
- **Origin checks**: `/mcp` only allows loopback browser origins for local HTTP use.
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
