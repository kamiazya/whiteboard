# Wire Protocol

This repo uses two main transport surfaces:

- MCP over `stdio` or Streamable HTTP
- Browser synchronization over WebSocket

## MCP surface

- `stdio` is the packaged distribution default.
- `/mcp` is the preferred local-development path.
- `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get` are exposed through the MCP SDK.

## WebSocket message families

The daemon and browser exchange JSON messages over WebSocket for canvas coordination.

Common server-to-client notifications include:

- `doc_update`
- `version_created`
- `restore_started`
- `restore_complete`
- `head_changed`

Common client-to-server traffic includes:

- document updates after local edits
- viewport or readiness signals
- canvas presence / connection state updates

## Payload shape

- JSON is used for control messages.
- Binary document payloads are used where Loro update transport is more efficient.
- Message handling is canvas-scoped by workspace and path.

## Why this matters

- `doc_update` is the core synchronization message for whiteboard state.
- `head_changed` keeps branch-aware views in sync after restore or branch moves.
- `restore_started` / `restore_complete` let the browser coordinate long-running restore flows without stale UI.

For MCP debugging steps, use [mcp-debugging](../mcp-debugging.md).
