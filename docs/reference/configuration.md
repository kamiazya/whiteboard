# Configuration

Runtime environment variables and sandbox quirks.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `WHITEBOARD_DATA_DIR` | Runtime data directory. Workspaces, snapshots, versions, and exports all live underneath it. | `~/.whiteboard` (falls back to the OS temp directory if unwritable) |
| `WHITEBOARD_CHROME_PATH` | Override the Chromium binary used for browser automation and `export_png`. | unset (Playwright-managed Chromium) |
| `WHITEBOARD_DEV` | When set to `1`, the dev-launch wrapper enables source-tree watching so a `tsx watch` change restarts the daemon in place. | unset |
| `WHITEBOARD_MCP_AUTHORIZATION_SERVER(S)` | Authorization Server URL exposed in MCP Protected Resource Metadata, in preparation for remote OAuth 2.1. | unset |
| `WHITEBOARD_MCP_RESOURCE` | Canonical MCP resource URL exposed in metadata. If unset, `/mcp` is derived from the incoming request URL. | unset |
| `WHITEBOARD_MCP_SCOPES_SUPPORTED` | Comma-separated list of scopes exposed in metadata. | unset |
| `MCP_HTTP_DEBUG` | When set to `1`, the HTTP MCP server logs `[mcp-http:init]` / `[mcp-http]` events to help diagnose request flow. | unset |
| `WHITEBOARD_ALLOWED_WEB_ORIGINS` | Comma-separated list of extra hosted origins admitted alongside the fixed loopback set (`localhost`, `127.0.0.1`, `::1`) on `/api/*` CORS, `/mcp`, and WS upgrade — **local-daemon mode only**. Each entry must be an exact `https://` origin (no path/query/fragment/credentials) **or** a `https://*.example.com` wildcard subdomain pattern (see below); bare `*` is rejected. Matching is case-insensitive on the host and normalizes the default `:443` port, but any other port is significant. An invalid entry aborts daemon startup with a logged error naming the offending entry's index (the raw value is never echoed). | unset (loopback-only, unchanged) |

Setting `WHITEBOARD_ALLOWED_WEB_ORIGINS` only widens which browser *origins*
the daemon will talk to over CORS/WS — it does not change authentication.
Mutating `/api/*` routes still require the daemon Bearer token, and `/mcp`
still requires its own auth regardless of origin. Only add an origin you
control; the hosted pairing flow this enables also depends on the browser's
own Local Network Access permission prompt (Chrome), which is a separate,
per-user consent step.

### Wildcard subdomain patterns

Both `WHITEBOARD_ALLOWED_WEB_ORIGINS` and `WHITEBOARD_SERVER_ALLOWED_ORIGINS`
accept a `https://*.example.com`-shaped entry alongside exact origins. This is
meant for deployment-preview shapes such as Cloudflare Pages branch previews
(`https://*.your-project.pages.dev`), where every branch gets its own
subdomain and listing each one explicitly is impractical.

Rules:

- The wildcard `*` must be the **entire leftmost label** and nothing else —
  `https://*.example.com` is valid; `https://foo*.example.com`,
  `https://*.*.example.com`, and bare `*` are all rejected.
- Only **one label** is matched: `https://preview.example.com` matches
  `https://*.example.com`, but `https://a.b.example.com` does not.
- The pattern must be `https://` — wildcards are never accepted for
  loopback `http://` origins.
- The static suffix after the wildcard must retain at least two labels
  (`example.com`, not `.dev` or `.com` alone). This is a structural check,
  not a public-suffix-list lookup — **`https://*.pages.dev` passes it but
  admits every Cloudflare Pages project**, not just yours. Always scope the
  pattern to your own project label, e.g.
  `https://*.your-project.pages.dev`.

## Codex sandbox constraints

Inside the Codex sandbox, two issues are common:

- **Writing to `~/.whiteboard` may fail.** Without an env override, the app automatically falls back to a temp directory.
- **Listening on `127.0.0.1:<port>` may be blocked.** Daemon startup fails with `Failed to bind daemon port ... (EPERM ...)`. Run in an environment that allows loopback listening or adjust the sandbox configuration.

## Storage layout

Each workspace lives at `${WHITEBOARD_DATA_DIR}/{workspaceId}/` and contains:

- `*.loro` — Loro CRDT snapshots (one per canvas)
- `*.png`, `*.excalidraw` — exports (via `export_png` / `canvas_export_json`)
- `palette.json`, `manifestJson`, library metadata, and other persisted JSON

See [architecture](../explanation/architecture.md) for how each layer reads and writes this tree.
