---
paths:
  - packages/daemon-client/**
---

# daemon-client — the daemon's browser-safe client half

## What belongs here

- The `/api` Zod contracts apps/web parses (`api-contracts/`): documents,
  branches, errors, fonts, pairing, runtime, and the URL builders. The barrel
  (`api-contracts/index.ts`) is deliberately NARROW — it is republished as an
  npm subpath by mcp-server, and every export is 0.0.x surface.
- The document backends the browser drives a daemon with: `daemon-backend`
  (WS), `sse-backend` + `sse-stream-hub` (SSE), `select-document-transport`,
  and the `document-backend-contract` types they implement.
- `api-client` (authorized fetch wrapper), `token-store`, `browser-tracing`
  (lazy OpenTelemetry web SDK), `upload-files`, the ws message/protocol
  contracts.
- `test-utils/`: the backend contract suites apps/web runs against its own
  implementations (`document-backend-contract`, `sse-stream-source-contract`).

## What does NOT belong here

- Anything only the daemon parses or executes: CLI `--json` contracts
  (daemon-doctor/status/run/stop), export contracts, server routes/stores —
  those stay in mcp-server.
- `node:*`, ambient Node globals (the `Buffer`-in-a-refine this extraction
  caught is the cautionary tale — the scan now catches the next one), React,
  inversify.

## Dependency rules

model + server-core (the version-entry/operator contracts published by the
routes), zod, and the OpenTelemetry browser SDK set. DOM globals are this
package's normal job (`WebSocket`/`EventSource`/`fetch`) — exempted as
`dom-global` in `architecture-map.ts`, the same carve-out canvas-viewer has.

## The shim relationship with mcp-server

mcp-server's `src/shared/*` old paths are one-line re-export shims: they keep
the published subpath exports (`publish-contract.test.ts` pins the exports
map by equality), the tsup entries, and mcp-server's internal relative
imports working. tsup's `noExternal` MUST list this package or the published
tarball carries a bare specifier for an unpublished workspace dep
(`document-backend-contract.subpath.test.ts` asserts the chain). Do not add
NEW imports through the shims; the follow-up increment rewrites mcp-server's
internals to import this package directly and retires them.

## Tests

Vitest project `daemon-client-node`. Contract round-trips use the package's
own `test-utils/fast-check.ts` (per-package numRuns default, the repo norm).
