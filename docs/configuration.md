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

## Codex sandbox constraints

Inside the Codex sandbox, two issues are common:

- **Writing to `~/.whiteboard` may fail.** Without an env override, the app automatically falls back to a temp directory.
- **Listening on `127.0.0.1:<port>` may be blocked.** Daemon startup fails with `Failed to bind daemon port ... (EPERM ...)`. Run in an environment that allows loopback listening or adjust the sandbox configuration.

## Storage layout

Each workspace lives at `${WHITEBOARD_DATA_DIR}/{workspaceId}/` and contains:

- `*.loro` — Loro CRDT snapshots (one per canvas)
- `*.png`, `*.excalidraw` — exports (via `export_png` / `canvas_export_json`)
- `palette.json`, `manifestJson`, library metadata, and other persisted JSON

See [architecture.md](./architecture.md) for how each layer reads and writes this tree.
