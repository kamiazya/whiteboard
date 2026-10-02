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

Common client-to-server traffic includes:

- document updates after local edits
- viewport or readiness signals
- canvas presence / connection state updates

## Payload shape

- JSON is used for control messages.
- Binary document payloads are used where Loro update transport is more efficient.
- Message handling is canvas-scoped by workspace and path.

## Version skew: strict requests, tolerant responses

The hosted app updates itself behind a service worker; the daemon is installed
separately. The two are routinely different versions, so the `/api` contracts in
`packages/daemon-client/src/api-contracts/` follow one rule:

- **A schema the daemon parses a request with is `.strict()`.** The daemon decides
  what it accepts, and refusing an undeclared field tells a caller its value did
  not take effect.
- **A schema the browser parses a response with is not.** A newer daemon adding a
  field is a compatible change; a strict reader would report a move that landed
  as failed, or refuse to unlock a replica. Zod's default object strips the
  unknown field, which is what a reader wants. This covers refusal bodies and
  the parts of a response too.
- **A daemon that wants to refuse an undeclared field it EMITS** applies
  `.strict()` at the emit site (`routes/replica-key.ts` does), where no browser
  sees it.

The split is made by declaration name — `*RequestSchema` may be strict, nothing
else in `api-contracts/` may — and `tools/arch-lint`'s
`api-contract-response-tolerance.test.ts` fails on a strict answer. What no test
yet covers is a recorded response from an older and a newer daemon parsed by the
other side's schemas.

## Why this matters

- `doc_update` is the core synchronization message for whiteboard state.
- `restore_started` / `restore_complete` let the browser coordinate long-running restore flows without stale UI.

For MCP debugging steps, use [mcp-debugging](../mcp-debugging.md).
