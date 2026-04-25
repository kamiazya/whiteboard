# MCP Debugging

This repo uses the official MCP Inspector as the default debugging tool for MCP work.

References:

- MCP Inspector: `https://modelcontextprotocol.io/docs/tools/inspector`
- MCP Debugging Guide: `https://modelcontextprotocol.io/docs/tools/debugging`

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

- After manual verification, preserve the scenario in `mcp-node`, `mcp-browser`, or E2E as appropriate

