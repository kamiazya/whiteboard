# MCP Debugging

This repo uses the official MCP Inspector as the default debugging tool for MCP work.

`AGENTS.md` is the short agent-facing workflow summary. This document is the human-facing debugging reference with the concrete MCP commands, protocol expectations, and verification steps.

References:

- MCP Inspector: `https://modelcontextprotocol.io/docs/tools/inspector`
- MCP Debugging Guide: `https://modelcontextprotocol.io/docs/tools/debugging`

## Protocol Support

This repo runs the MCP TypeScript SDK **v2 packages** (`@modelcontextprotocol/server` / `client`) and serves **both protocol eras** on every transport:

- **2026-07-28 (modern)**: each request is self-contained (no `initialize` handshake, no `Mcp-Session-Id`; `_meta` carries `protocolVersion`/`clientCapabilities`). On HTTP `/mcp` this is served by `createMcpHandler` (per-request factory, `legacy: 'reject'`); the route classifies eras with `isLegacyRequest` — the exact predicate the handler itself uses. On stdio, `serveStdio` pins the connection's era at the opening exchange.
- **2025-era (legacy)**: served by the pre-existing hand-wired stateless path (fresh per-request `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse: true`) so legacy clients' response framing (plain JSON bodies) is byte-compatible with what the stdio proxy and the web app expect. Legacy `initialize` negotiation is unchanged:
  - a supported protocol version is echoed back;
  - an unsupported version falls back to the SDK latest legacy version.

Legacy versions accepted by the SDK's `initialize` negotiation:

- `2025-11-25` (SDK latest legacy fallback)
- `2025-06-18`
- `2025-03-26`
- `2024-11-05`
- `2024-10-07`

Note: the deprecated core Logging capability (`logging/setLevel` + `notifications/message`) still works for legacy-era sessions; on modern-era requests the SDK only emits log notifications when the client opts in via the `io.modelcontextprotocol/logLevel` `_meta` key. Structured logs always reach stderr regardless.

When upgrading the `@modelcontextprotocol/*` packages, re-check this matrix, the era tests (`app.test.ts` modern-pinned client, `serve-stdio-eras.test.ts`), and the related initialize tests before shipping.

## Recommended Flow

1. Start the dev daemon in watch mode (`pnpm mcp:http:dev`).
2. Open Inspector on the development stdio proxy (`pnpm mcp:inspect`), which reaches the daemon's `/mcp` over its socket.
3. Verify `initialize` and `tools/list` first.
4. Reproduce the target tool call in Inspector before debugging inside Codex or Claude Code.
5. If the problem only appears in a real client, compare:
   - Inspector result
   - client logs
   - `/mcp` debug logs with `MCP_HTTP_DEBUG=1`

## Commands

From the repo root:

```bash
pnpm mcp:http:dev
pnpm mcp:inspect
pnpm mcp:inspect:stdio
pnpm mcp:debug:http
```

What each does:

- `pnpm mcp:http:dev`: starts the local daemon in watch mode; it serves `/mcp` on its owner-only socket (a named pipe on Windows) and listens on no TCP port (ADR-0050)
- Claude Code / Codex sessions reach that endpoint through the stdio proxy `packages/mcp-server/scripts/dev/mcp-http-stdio-proxy.mjs` (spawned per session; ensures the daemon, waits for readiness, retries per request across watch restarts). It forwards over the owner-only socket the daemon names in `<dataDir>/daemon.json` (`socketPath`, ADR-0050 decision 2): while there is no record — the daemon is starting, or between the halves of a watch restart — a request waits within the retry budget for one to appear. A client on that socket still sends the bearer token, since the socket serves the same app with the same checks — `curl --unix-socket <path> http://localhost/mcp …`. Claude Code reads the proxy from a LOCAL-scope registration (`claude mcp add --scope local … mcp-http-stdio-proxy.mjs`, once per checkout), which shadows `.mcp.json`'s published `npx` definition; `settings.json` has no `mcpServers` field, so never define servers there. Inspector goes through the same proxy.
- `pnpm mcp:inspect`: starts the official MCP Inspector UI on the same stdio proxy, so it reaches this checkout's dev daemon over its socket (starting one if none answers). Inspector has no Unix-socket transport of its own.
- `pnpm mcp:inspect:stdio`: starts Inspector against the raw stdio MCP entrypoint
- `pnpm mcp:debug:http`: runs `mcp:http:dev` and Inspector together for quick iteration

## First-Pass HTTP Debug Loop

1. Start the daemon:

```bash
pnpm mcp:http:dev
```

2. In another terminal, open Inspector. It launches the stdio proxy itself, so there is no URL to enter:

```bash
pnpm mcp:inspect
```

3. Run these calls in order:
   - `initialize`
   - `tools/list`
   - the failing `tools/call`

4. Only compare against Codex or Claude Code after Inspector reproduces or disproves the problem.

## When To Use HTTP vs STDIO

- Prefer HTTP (`/mcp`) for active development. The stdio proxy the client launches retries across daemon restarts, so a code change restarts the daemon without reconnecting the client; the daemon listens on an owner-only socket, not a TCP port.
- Use stdio Inspector only when validating the standalone packaged MCP entrypoint or debugging stdio-specific startup issues.

## Enable Request Logging

Set `MCP_HTTP_DEBUG=1` before starting the HTTP daemon:

```bash
MCP_HTTP_DEBUG=1 pnpm mcp:http:dev
```

This logs:

- `initialize` payload summary, including advertised client capabilities
- per-request timing for `/mcp`
- JSON-RPC method name
- request id
- HTTP status

Log format: the daemon logger writes one JSON line per record to `stderr` (never stdout, which carries the stdio frames), with `"scope":"mcp-http"`. The `msg` field says which event it is:

- `mcp-http:init` — the `initialize` payload summary
- `mcp-http` — the per-request line (`httpMethod`, `path`, `jsonrpcMethod`, `requestId`, `status`, `durationMs`)
- `mcp-http:construct` / `mcp-http:destruct` (and `-skipped` / `-error`) — per-request server lifecycle timing

`MCP_HTTP_DEBUG=1` lowers `WHITEBOARD_LOG_LEVEL` to `info` so these records survive the default `warning` gate; filter them with, for example, `jq 'select(.scope == "mcp-http")'`.

## Debug Checklist

### 1. Transport sanity

- Does the daemon answer on its socket, the way the proxy and the hooks reach it? From the checkout root:
  `curl --unix-socket "$(node -p "require('./.dev-data/daemon.json').socketPath")" http://localhost/api/runtime/ping` should return `200`. No `daemon.json` means no daemon is running for this checkout's data dir.
- Does Inspector (`pnpm mcp:inspect`) connect through the proxy?
- Does `tools/list` succeed?

### 2. Capability negotiation

- Inspect the `initialize` exchange
- Confirm which `protocolVersion` the client asked for and which version the server returned
- Confirm the client actually advertises the capabilities your server expects
- Treat capability mismatch as a first-class cause of `-32602` and related integration failures

### 3. Tool contract

- Reproduce the failing call in Inspector
- Compare the tool input schema shown by Inspector with what the client actually sends
- Check whether the issue reproduces in Inspector before blaming the client

### 4. Runtime-specific issues

- If Inspector works but the client fails, inspect the client logs and UI developer tools
- For Claude-family clients, check MCP/client logs and browser-style DevTools where available

### 5. Regression

- After manual verification, preserve the scenario in `mcp-node`, `web-browser`, or E2E as appropriate

## Database Migration Errors

If the daemon fails to start with:

```
Database migration failed: corrupted migrations: previously executed migration 0002-canvases-last-compacted-at is missing
```

or with:

```
IncompatibleDatabaseError: Database is incompatible with this build — its migration
history records a migration this version does not ship.
```

your local database is incompatible with the current codebase. Both wordings
are the same situation from opposite sides — a migration the database recorded
that this build no longer has, usually because it was renamed. Renumbering one
does that to every database that already ran it, which the pre-1.0 policy below
permits; `published-migration-names.ts` is what makes such a rename land in a
diff a reviewer sees rather than silently.

**Pre-1.0 policy**: the data dir's databases are **disposable**. On an incompatible upgrade, re-create the database. `pnpm mcp:http:dev` defaults to the repo-local `.dev-data/` dir (see [development.md](./development.md)) rather than the packaged install's `~/.whiteboard` — adjust the path below if you set `WHITEBOARD_DATA_DIR` yourself:

```bash
# 1. Stop any running daemon first
# 2. Back up any canvas files you want to keep
cp -r .dev-data .dev-data.bak

# 3. Remove the database
rm .dev-data/whiteboard.db

# 4. Restart the daemon — it will create a fresh database
pnpm mcp:http:dev
```

The daemon should print `READY` after re-creating the schema from scratch.

A fresh `WHITEBOARD_DATA_DIR` always works as a quick sanity check:

```bash
WHITEBOARD_DATA_DIR=/tmp/wb-test WHITEBOARD_DEV=1 pnpm mcp:http:dev
```

If instead the daemon fails to start with:

```
Database migration failed: permission denied reading the data directory. Check filesystem
permissions on the blob directories under <data dir>/tenants/<tenant>/blobs (or
<data dir>/blobs on a data directory this daemon has not started yet) and restart.
```

a migration hit a permission error walking the data dir's filesystem tree (not the SQLite file
itself) — typically an externally-changed owner/mode under a tenant's blob directory
(`<data dir>/tenants/<tenant>/blobs`, or the pre-tenant `<data dir>/blobs` a first start moves),
or a restrictive umask. Fix the directory's permissions (or ownership) and restart; this is not a
disposable-database case, so do not delete `whiteboard.db`.

## MCP Tools Not Visible After Starting Daemon

If you start the daemon **after** opening a Claude Code (or Codex) session, the whiteboard
MCP tools will not appear in that session. MCP connections are established at session start;
a daemon launched mid-session is not picked up automatically.

**Fix:** start the daemon first, then start or restart the Claude Code session.

```bash
# 1. Start the daemon
pnpm mcp:http:dev

# 2. Open a new Claude Code session (or run /mcp reconnect if your client supports it)
```

The repo-local `SessionStart` hook (`packages/mcp-server/scripts/dev/ensure-http-dev-daemon.mjs`)
pings `/api/runtime/ping` over the socket named in this checkout's daemon record, and auto-spawns
the daemon when nothing answers as a session opens, so in normal use this situation should not arise. If the hook is disabled
or the project is not yet trusted, start the daemon manually before opening the session.

If MCP tools go missing mid-session with no error, check whether the daemon is still answering on
its socket (the `curl --unix-socket` line in the checklist above) before assuming a client bug — `mcp:http:dev` passes
`--idle-timeout-ms=0` specifically so the dev daemon never self-terminates on idle, but a daemon
started without that flag (a stale build, a hand-run `pnpm --filter @kamiazya/whiteboard-mcp exec
node dist/server/index.js`) still inherits the packaged 15-minute idle-shutdown default and
can vanish silently, since the `SessionStart` hook only fires once per session and never re-spawns
mid-session. A second daemon started for the same data dir finds the socket answering and exits
with `another daemon is already listening on this socket` rather than taking it over.

If the hook itself times out waiting for the spawned daemon to answer the ping on its socket, it
prints `MCP tools will be unavailable for this session` and exits non-zero — the session
starts anyway, just without whiteboard MCP tools; check `tmp/logs/mcp-http-dev.log` for what the
daemon was doing, then start it manually (`pnpm mcp:http:dev`) and reconnect. The wait bound
defaults to 30s (cold `tsx` + `happy-dom` + canvas + resvg startup) and is overridable via
`WHITEBOARD_DEV_READY_TIMEOUT_MS` (milliseconds; a non-numeric, non-integer, zero, or negative
value falls back to the 30s default) — mainly useful for shortening the wait when scripting or
testing the hook itself, not something a normal dev session needs to set.
