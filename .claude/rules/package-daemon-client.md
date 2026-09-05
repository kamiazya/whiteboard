---
paths:
  - packages/daemon-client/**
---

# daemon-client — the daemon's browser-safe client half

## What belongs here

- The `/api` Zod contracts apps/web parses (`api-contracts/`): documents,
  branches, errors, fonts, pairing, runtime, and the URL builders. The barrel
  (`api-contracts/index.ts`) is deliberately NARROW — it is the whole
  contract surface apps/web reads (`api-contracts-barrel.test.ts` pins it).
- The document backends the browser drives a daemon with: `daemon-backend`
  (WS), `sse-backend` + `sse-stream-hub` (SSE), `select-document-transport`,
  and the `document-backend-contract` types they implement.
- `api-client` (authorized fetch wrapper — injects a `traceparent` header
  through @opentelemetry/api's no-op surface, no SDK shipped), `token-store`,
  `upload-files`, the ws message/protocol contracts.
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

## The relationship with mcp-server

Both composition roots import this package directly; the `src/shared/*`
re-export shims and mcp-server's published client subpaths are retired
(`publish-contract.test.ts` pins the exports map — `.` and `./package.json`
only). tsup's `noExternal` MUST list this package or the published tarball
carries a bare specifier for an unpublished workspace dep.

## Tests

Vitest project `daemon-client-node`. Contract round-trips use the package's
own `test-utils/fast-check.ts` (per-package numRuns default, the repo norm).
