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
routes), history (the branch schema the `/branches` contract re-exports —
what a branch IS is the mechanic's, not the wire's), zod, and the
OpenTelemetry browser SDK set. DOM globals are this
package's normal job (`WebSocket`/`EventSource`/`fetch`) — exempted as
`dom-global` in `architecture-map.ts`, the same carve-out canvas-viewer has.

## The relationship with mcp-server

Both composition roots import this package directly; the `src/shared/*`
re-export shims and mcp-server's published client subpaths are retired
(`publish-contract.test.ts` pins the exports map — `.` and `./package.json`
only). tsup's `noExternal` MUST list this package or the published tarball
carries a bare specifier for an unpublished workspace dep.

## The exports map is explicit, and that is the dead-export gate

`package.json` lists each consumed subpath individually — never a `"./*"`
wildcard. The wildcard made every module a knip entry point, so the package
was structurally blind to dead exports: browser-tracing.ts shipped an entire
unused SDK half (and browser-shared-index.ts a dead barrel) under a green
knip. With the explicit map, an unconsumed module fails `pnpm knip` as an
unused file, and a NEW subpath is added here in the same diff that first
imports it — the resolve error is loud if forgotten.

## Tests

Vitest project `daemon-client-node`. Contract round-trips use the package's
own `test-utils/fast-check.ts` (per-package numRuns default, the repo norm).

**The WebSocket text messages are guarded from the emitting side, not
only the parsing side.** `ws-messages.property.test.ts` here draws every
arm of `serverTextMessageSchema` and round-trips it through
`parseServerTextMessage`, which says only that what the schema admits is
what JSON carries — its generator is built from the parser's own schema,
so narrowing the schema narrows the generator and a drift between the two
ends passes (measured: dropping a union arm and turning `scrollX` into an
integer both stayed green). The drift guard is mcp-server's
`routes/ws-emitters.property.test.ts`: it drives the daemon's hand-written
emitters (`sendVersionCreated`, `sendRestoreEvent`, `sendAgentActivity`,
`sendHeadChanged`, `sendViewportRequest`) with what their parameters
admit, reads the frame off a connected fake socket, and requires it to
parse under this package's schema AND equal, raw, the message composed
from the arguments — the second because the parser strips a key it does
not know, so an emitter adding a field the schema never learned passes the
first. Mutation-checked both ways (a wrapped `head`, an extra `padding`).

`viewportRequestParamsSchema` is the viewport message minus what the
daemon stamps on it, strict, and it is what the daemon's viewport route
checks a body against. Before it existed the route forwarded its raw JSON
body into the frame, and the browser dropped a frame it could not read —
so a wrong-typed `zoom` answered 504 after the timeout rather than 400,
and `padding`, which the browser has never read, was accepted as a silent
no-op.
