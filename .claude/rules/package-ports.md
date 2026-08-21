---
paths:
  - "packages/ports/**"
---

# ports — store/sync port contracts (contracts-only, no implementations)

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
  the loro-crdt runtime and belongs in `codec`/`crdt`.
- Any implementation-specific constant (e.g. the Cloudflare Durable Objects
  ~2MB message cap) — `chunkSnapshot`'s `maxChunkBytes` is always a
  caller-supplied parameter.

## Dependency rules

- Runtime dependencies: `@kamiazya/whiteboard-model` (workspace) and
  `zod` (via `catalog:`) only. Forbidden imports: `node:*`, DOM globals,
  `inversify`, `loro-crdt`.

## Conventions

- Every DTO is a `.strict()` Zod object (extra keys reject) unless
  explicitly documented otherwise (`workspaceMetaSchema`-style open records
  do not appear in this package).
- `DocumentStore` and `BlobStore` are not workspace-scoped per-instance —
  a document's scope travels inside its `DocRef`, and blobs are
  deliberately global/content-addressed.
- `workspaceIdSchema` (added to `model`) is a path-safe **slug**
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

## Conformance suites (`src/test-utils/`)

All three ports ship their guarantees as a suite every implementation calls,
rather than as prose each implementation re-reads:
`describeDocumentIndexConformance`, `describeBlobStoreConformance` and
`describeDocumentStoreConformance`. Each takes a factory returning
`{ <port>, dispose }`, so the fixture stays with the implementation and the
assertions stay here.

They must run unchanged in a browser like the rest of the package — the blob
suite computes its expected digest with `globalThis.crypto.subtle`, never
`node:crypto`, and every `Uint8Array` a suite hands to a port is annotated
`Uint8Array<ArrayBuffer>`, because a bare `Uint8Array` widens to
`ArrayBufferLike` under a consumer whose lib includes DOM and then will not
assign to the port's own DTOs.

A conformance seam may need something an implementation must PROVIDE rather
than something it answers — `describeDocumentStoreConformance` takes a
`writeUnreadableRecord` so a store can be put into the state its own reader
refuses. Make such a seam REQUIRED, not optional: an optional one is skipped
silently by exactly the implementation that needed checking. And require only
what every implementation can actually reach — the same seam originally took
a `code` naming which unreadable shape to write, which had to be dropped
because `unsupported-version` is not a state a store of typed COLUMNS can be
in at all. The shared bar is what they can all be held to; the rest belongs
in each implementation's own test.

**Write the suite before the implementation, and mutation-check it before
trusting it.** The `DocumentStore` suite was written from three existing
files (the in-memory double's, the libSQL store's, and a parity property
between them) and immediately found a real disagreement: the double returned
chunks in insertion order where the real store sorts by index, which the
parity property had missed because its generator only ever produced them in
order. Two implementations agreeing is not the same as a contract.

`docRefKey` lives here for the same reason. It is a STORED key, and two
stores that spell it differently cannot read each other's documents — with
nothing to say so at compile time.

## Tests

- Vitest project: `ports-node` (registered in root
  `vitest.config.ts`).
- Every schema has accept + reject example tests; `chunkSnapshot`/
  `reassembleSnapshot` also have fast-check round-trip and
  order-independence properties (`src/snapshot-helpers.properties.test.ts`,
  `src/negotiate-protocol-version.properties.test.ts`).
- `src/smoke.test.ts` imports the package by its published specifier
  (`@kamiazya/whiteboard-ports`), not a relative path, to exercise
  `package.json` `exports` resolution the way a real consumer will.

## Common mistakes (append as review finds them)

- Adding a hand-written interface next to a schema instead of `z.infer`.
- Hardcoding an implementation's chunk-size cap into `chunkSnapshot`
  instead of taking it as a parameter.
- Treating an out-of-order chunk set as a `reassembleSnapshot` failure —
  it is a success case.
