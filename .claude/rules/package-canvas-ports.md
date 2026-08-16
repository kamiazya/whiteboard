---
paths:
  - "packages/canvas-ports/**"
---

# canvas-ports — store/sync port contracts (contracts-only, no implementations)

## What belongs here

- Named `z.infer` DTO schemas for every request/result payload crossing a
  store/sync boundary: `DocRef`, `Frontier`, `ProtocolVersion`,
  `SnapshotChunk`, `SnapshotManifest`, `DeltaBatch`, the five sync messages
  (`hello`/`welcome`/`resume`/`catchUp`/`update`), `PresenceState`,
  `BlobRef`, plus every port method's input and result DTO.
- Hand-written TS port interfaces wired to those DTOs via `z.infer`:
  `DocumentStore`, `BlobStore`, `PresenceChannel`.
- The Symbol `TOKENS` aggregate (`defineToken`, `Token<T>`) for DI wiring.
- Three canonical pure helpers, a **deliberate exception** to the
  contracts-only rule because they are model-only and loro-independent:
  `chunkSnapshot`, `reassembleSnapshot` (fails via the named
  `SnapshotReassemblyError` with a discriminated `code`), and
  `negotiateProtocolVersion`.

## What does NOT belong here

- Any store/sync **implementation** (local libSQL/fs, IndexedDB, Durable
  Objects/D1/R2) — those live in `mcp-server` / `apps/web` / a future
  Cloudflare composition root.
- InversifyJS `ContainerModule` wiring — composition roots own that.
- Frontier ordering, dominance, or comparison logic — `Frontier` is an
  **opaque** `z.instanceof(Uint8Array)` here; comparing frontiers requires
  the loro-crdt runtime and belongs in `canvas-codec`/`canvas-workspace`.
- Any implementation-specific constant (e.g. the Cloudflare Durable Objects
  ~2MB message cap) — `chunkSnapshot`'s `maxChunkBytes` is always a
  caller-supplied parameter.

## Dependency rules

- Runtime dependencies: `@kamiazya/whiteboard-canvas-model` (workspace) and
  `zod` (via `catalog:`) only. Forbidden imports: `node:*`, DOM globals,
  `inversify`, `loro-crdt`.

## Conventions

- Every DTO is a `.strict()` Zod object (extra keys reject) unless
  explicitly documented otherwise (`workspaceMetaSchema`-style open records
  do not appear in this package).
- `DocumentStore` and `BlobStore` are not workspace-scoped per-instance —
  a document's scope travels inside its `DocRef`, and blobs are
  deliberately global/content-addressed.
- `workspaceIdSchema` (added to `canvas-model`) is a path-safe **slug**
  (`/^[a-zA-Z0-9_-]+$/`, non-empty) — NOT a ULID. It codifies the
  workspace-ID contract already enforced at runtime by mcp-server's
  `SAFE_WORKSPACE_ID`. Do not conflate it with `canvasIdSchema`.
- `PresenceChannel.publish`/`subscribe` are control-plane operations
  (Promise-returning method, callback function, unsubscribe function) and
  are the one documented DTO-rule exemption; the callback's *payload*
  (`PresenceState`) is a DTO and is fully validated.
- `reassembleSnapshot` is order-independent (chunks are sorted by `index`
  before validation) — an out-of-order but otherwise well-formed chunk set
  is a success, never a `SnapshotReassemblyError`.
- `snapshotChunkSchema` rejects a zero-byte chunk. This is what keeps the
  valid empty-snapshot manifest (`chunkCount: 0, chunks: []`) unambiguous
  from an invalid populated chunk list containing an empty chunk.
- `SnapshotManifest` does NOT carry `docRef` — it describes only the
  chunking; which document it belongs to is always a separate
  store-operation argument.
- Every exported type is `z.infer`-derived; a hand-written interface next
  to a schema (or a port method typed with anything other than the named
  DTO) is the exact drift class this package exists to prevent — see the
  compile-time `expectTypeOf` conformance test per port method in
  `src/types.test.ts`.

## Tests

- Vitest project: `canvas-ports-node` (registered in root
  `vitest.config.ts`).
- Every schema has accept + reject example tests; `chunkSnapshot`/
  `reassembleSnapshot` also have fast-check round-trip and
  order-independence properties (`src/snapshot-helpers.properties.test.ts`,
  `src/negotiate-protocol-version.properties.test.ts`).
- `src/smoke.test.ts` imports the package by its published specifier
  (`@kamiazya/whiteboard-canvas-ports`), not a relative path, to exercise
  `package.json` `exports` resolution the way a real consumer will.

## Common mistakes (append as review finds them)

- Adding a hand-written interface next to a schema instead of `z.infer`.
- Hardcoding an implementation's chunk-size cap into `chunkSnapshot`
  instead of taking it as a parameter.
- Treating an out-of-order chunk set as a `reassembleSnapshot` failure —
  it is a success case.
