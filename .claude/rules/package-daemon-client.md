---
paths:
  - packages/daemon-client/**
---

# daemon-client — the daemon's browser-safe client half

## What belongs here

- The `/api` Zod contracts apps/web parses (`api-contracts/`): documents,
  fonts, runtime, membership, promotion, replica keys, people, sign-in, the
  `did:key` helpers and the URL builders. The barrel
  (`api-contracts/index.ts`) is deliberately NARROW — it is the whole
  contract surface apps/web reads (`api-contracts-barrel.test.ts` pins it).
- **Strict requests, tolerant answers.** The hosted app and the daemon update
  independently, so a schema the browser parses an answer with is NOT
  `.strict()` and one the daemon parses a request with is; the line is the
  declaration's name (`*RequestSchema`), held by arch-lint's
  `api-contract-response-tolerance.test.ts` and explained in
  `docs/contributing/architecture/wire-protocol.md`.
- **A new enum VALUE is the same skew as a new key.** `tolerantAnswer` strips
  an unknown key and also reads an unknown member of an OPTIONAL enum as
  absent (`unknownIsAbsent`); a required enum a reader only displays degrades
  through `.catch` to its neutral member (operator kind -> `system`,
  compaction reason -> `no-gain`) via the browser-side `*AnswerSchema`
  variants, never by loosening the schema the daemon emits or parses a
  request with. An enum a DECISION is made on stays lockstep.
  `answers-tolerant.test.ts` lists every enum a browser-parsed answer still
  reads strictly in `LOCKSTEP` with its reason, from both sides; adding an
  enum to an answer means degrading it or listing it.
- Values the browser and the daemon must agree on are declared ONCE here and
  imported by both sides: the uploadable image types and the 16 MiB ceiling
  (`api-contracts/files`, which the daemon's file route and body limit and
  the editor's `accept`/refusal all read), and the key widths (`key-widths`:
  `PRF_OUTPUT_BYTES`, `DERIVED_KEY_BITS`).
- The one document backend the browser drives a daemon with (ADR-0050
  retired the WebSocket): `sse-backend` over `sse-stream-hub`, and the
  `document-backend-contract` types it implements. The SSE wire itself is
  `sync-sse-contract`, and `ws-messages` / `ws-text-message` are the text
  frames that stream carries (the name predates the transport).
- `api-client` (same-origin fetch wrapper — injects a `traceparent` header
  through @opentelemetry/api's no-op surface, no SDK shipped), the extension
  bridge the hosted page reaches a daemon through, the read plane and the
  replica session key helpers (ADR-0042).
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
routes), zod, `@opentelemetry/api` (the no-op propagation surface alone) and
`multiformats` (what a `did:key` is). DOM globals are this package's normal
job (`fetch`, `ReadableStream`) — exempted as `dom-global` in
`architecture-map.ts`, the same carve-out canvas-viewer has.

## The relationship with mcp-server

Both composition roots import this package directly; the `src/shared/*`
re-export shims and mcp-server's published client subpaths are retired
(`publish-contract.test.ts` pins the exports map — `.` and `./package.json`
only). tsdown's `noExternal` MUST list this package or the published tarball
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

**The live-sync text messages are guarded from the emitting side, not
only the parsing side.** `ws-messages.property.test.ts` here draws every
arm of `serverTextMessageSchema` and round-trips it through
`parseServerTextMessage`, which says only that what the schema admits is
what JSON carries — its generator is built from the parser's own schema,
so narrowing the schema narrows the generator and a drift between the two
ends passes (measured: dropping a union arm and turning `scrollX` into an
integer both stayed green). The drift guard is mcp-server's
`routes/sync-audience.test.ts`: it drives the daemon's hand-written
emitters (`sendVersionCreated`, `sendRestoreEvent`, `sendAgentActivity`,
`sendViewportRequest`) with what their parameters
admit, reads the frame each hands the SSE broadcaster, and requires it to
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
