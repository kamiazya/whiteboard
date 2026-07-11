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
| `WHITEBOARD_ALLOWED_WEB_ORIGINS` | Comma-separated list of extra hosted origins admitted alongside the fixed loopback set (`localhost`, `127.0.0.1`, `::1`) on `/api/*` CORS, `/mcp`, and WS upgrade — **local-daemon mode only**. Each entry must be an exact `https://` origin (no path/query/fragment/credentials); wildcards are rejected. Matching is case-insensitive on the host and normalizes the default `:443` port, but any other port is significant. An invalid entry aborts daemon startup with a logged error naming the offending entry's index (the raw value is never echoed). Can also be set via a [config file](#config-file-local-daemon)'s `allowedWebOrigins` key; this env var always wins. | unset (loopback-only, unchanged) |

Setting `WHITEBOARD_ALLOWED_WEB_ORIGINS` only widens which browser *origins*
the daemon will talk to over CORS/WS — it does not change authentication.
Mutating `/api/*` routes still require the daemon Bearer token, and `/mcp`
still requires its own auth regardless of origin. Only add an origin you
control; the hosted pairing flow this enables also depends on the browser's
own Local Network Access permission prompt (Chrome), which is a separate,
per-user consent step.

## Config file (local daemon)

As an alternative to exporting env vars by hand, the local daemon (`whiteboard
daemon run`, and the `server/index.ts` HTTP entrypoint) auto-loads a config
file. The first match wins, searched in this order while walking up from the
current directory:

1. `.whiteboardrc`
2. `.whiteboardrc.json`
3. `.whiteboardrc.yaml`
4. `.whiteboardrc.yml`
5. `.whiteboard/config.yaml`
6. `.whiteboard/config.yml`
7. `whiteboard.config.json`
8. `package.json` (`"whiteboard"` field)

If nothing is found from the current directory upward, `~/.whiteboard/config.yaml`
is consulted as a per-machine fallback. Only declarative JSON/YAML/rc formats
are supported — `whiteboard.config.js` and similar JS loaders are deliberately
NOT searched, so a config file can never execute code at daemon startup.

Example `.whiteboard/config.yaml`:

```yaml
allowedWebOrigins:
  - https://kamiazya-whiteboard.pages.dev
port: 3123
logLevel: info
```

Supported keys: `allowedWebOrigins` (string array), `port` (1-65535),
`token`, `logLevel` (`debug` / `info` / `notice` / `warning` / `error` /
`critical` / `alert` / `emergency`), and `dataDir`. Unknown keys are logged
as a warning and dropped rather than silently ignored; an invalid value
(wrong type, out-of-range port, etc.) aborts startup with an error naming
the file path and the offending key.

**Precedence: environment variable > config file > built-in default.** Any
`WHITEBOARD_*` env var that is already set always wins over the same value
in a config file. The daemon logs which config file it loaded (path only,
never the token value) at startup.

Two scoped exceptions worth knowing:

- **`port`**: a config-file port behaves exactly like an explicit `--port` —
  the daemon does not auto-scan for another free port if that one is busy,
  it fails hard and names the port and the config file. Auto-scan from 3099
  only happens when neither `--port` nor a config-file port is set.
- **`dataDir`**: honored on the `whiteboard daemon run` CLI path only. The
  `server/index.ts` HTTP entrypoint resolves its data directory at module
  import time, before a config file can be loaded, so a `dataDir` key there
  produces a startup warning instead of silently doing nothing — use
  `WHITEBOARD_DATA_DIR` on that entrypoint instead.

**Security note:** a `token` value in a config file is a dev-only
convenience — treat it like a `.env` file with a secret in it (do not commit
it, restrict its file permissions). Prefer `WHITEBOARD_TOKEN` /
`WHITEBOARD_DAEMON_TOKEN` for anything beyond local development.

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
