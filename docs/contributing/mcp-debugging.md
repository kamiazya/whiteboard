# MCP Debugging

This repo uses the official MCP Inspector as the default debugging tool for MCP work.

`AGENTS.md` is the short agent-facing workflow summary. This document is the human-facing debugging reference with the concrete MCP commands, protocol expectations, and verification steps.

References:

- MCP Inspector: `https://modelcontextprotocol.io/docs/tools/inspector`
- MCP Debugging Guide: `https://modelcontextprotocol.io/docs/tools/debugging`

## Protocol Support

This repo currently relies on the installed `@modelcontextprotocol/sdk` negotiation behavior rather than overriding protocol negotiation inside the app.

- If the client asks for a supported protocol version, the server echoes that version in `initialize`.
- If the client asks for an unsupported version, the server falls back to the SDK latest protocol version.

Current SDK-supported versions in this repo:

- `2025-11-25` (SDK latest fallback)
- `2025-06-18`
- `2025-03-26`
- `2024-11-05`
- `2024-10-07`

When upgrading `@modelcontextprotocol/sdk`, re-check this matrix and the related initialize tests before shipping.

## Recommended Flow

1. Start the daemon-hosted HTTP MCP server in watch mode.
2. Connect Inspector to `http://127.0.0.1:3099/mcp`.
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

- `pnpm mcp:http:dev`: starts the local daemon in watch mode and exposes MCP at `http://127.0.0.1:3099/mcp`
- `pnpm mcp:inspect`: starts the official MCP Inspector UI
- `pnpm mcp:inspect:stdio`: starts Inspector against the raw stdio MCP entrypoint
- `pnpm mcp:debug:http`: runs `mcp:http:dev` and Inspector together for quick iteration

## First-Pass HTTP Debug Loop

1. Start the daemon:

```bash
pnpm mcp:http:dev
```

2. In another terminal, open Inspector:

```bash
pnpm mcp:inspect
```

3. Point Inspector at:

```text
http://127.0.0.1:3099/mcp
```

4. Run these calls in order:
   - `initialize`
   - `tools/list`
   - the failing `tools/call`

5. Only compare against Codex or Claude Code after Inspector reproduces or disproves the problem.

## When To Use HTTP vs STDIO

- Prefer HTTP (`/mcp`) for active development. The client keeps the same URL while the daemon restarts on code changes.
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

Log format:

- `[mcp-http:init]`
- `[mcp-http]`

## Debug Checklist

### 1. Transport sanity

- Does `http://127.0.0.1:3099/api/runtime/ping` return `200`?
- Does Inspector connect to `http://127.0.0.1:3099/mcp`?
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

or a similar "corrupted migrations" message, your local database is incompatible with the current codebase.

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
probes this checkout's derived dev port (3099 on the main checkout) and auto-spawns the daemon
when a session opens, so in normal use this situation should not arise. If the hook is disabled
or the project is not yet trusted, start the daemon manually before opening the session.

If MCP tools go missing mid-session with no error, check whether the daemon is still listening
(`curl -I http://127.0.0.1:<port>/api/status`) before assuming a client bug — `mcp:http:dev` passes
`--idle-timeout-ms=0` specifically so the dev daemon never self-terminates on idle, but a daemon
started without that flag (a stale build, a hand-run `pnpm --filter @kamiazya/whiteboard-mcp exec
node dist/server/index.js --daemon`) still inherits the packaged 15-minute idle-shutdown default and
can vanish silently, since the `SessionStart` hook only fires once per session and never re-spawns
mid-session. If two processes race to bind the same port, the loser now logs one classified
`{ port, code: 'EADDRINUSE' }` record via `getLogger('http-server')` and exits, instead of the raw
unhandled-`'error'`-event stack trace `tmp/logs/mcp-http-dev.log` used to accumulate.

If the hook itself times out waiting for the spawned daemon to answer an authenticated `/mcp`
probe, it prints `MCP tools will be unavailable for this session` and exits non-zero — the session
starts anyway, just without whiteboard MCP tools; check `tmp/logs/mcp-http-dev.log` for what the
daemon was doing, then start it manually (`pnpm mcp:http:dev`) and reconnect. The wait bound
defaults to 30s (cold `tsx` + `happy-dom` + canvas + resvg startup) and is overridable via
`WHITEBOARD_DEV_READY_TIMEOUT_MS` (milliseconds; a non-numeric, non-integer, zero, or negative
value falls back to the 30s default) — mainly useful for shortening the wait when scripting or
testing the hook itself, not something a normal dev session needs to set.
