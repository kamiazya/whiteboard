---
paths:
  - "packages/ports/**"
---

# ports — store/sync port contracts (contracts-only, no implementations)

## What belongs here

- Named `z.infer` DTO schemas for every request/result payload crossing a
  store/sync boundary: `DocRef`, `Frontier`, `SnapshotChunk`,
  `SnapshotManifest`, `BlobRef`, the delta batch and the document-index
  row, plus every port method's input and result DTO — what
  `packages/ports/src/index.ts` exports, and nothing it does not.
- Hand-written TS port interfaces wired to those DTOs via `z.infer`:
  `DocumentStore`, `BlobStore`, `DocumentIndex`.
- The Symbol `TOKENS` aggregate (`defineToken`, `Token<T>`) for DI wiring.
- Two canonical pure helpers, a **deliberate exception** to the
  contracts-only rule because they are model-only and loro-independent:
  `chunkSnapshot`, `reassembleSnapshot` (fails via the named
  `SnapshotReassemblyError` with a discriminated `code`).

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
- `workspaceIdSchema` (in `model`) is a path-safe id
  (`/^[a-zA-Z0-9_-]+$/`, non-empty) — NOT a ULID. `model`'s
  `WORKSPACE_ID_PATTERN` is the one definition; mcp-server's `validators.ts`
  imports it. Do not conflate it with a document id.
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
assertions stay here. `describeDocumentPinsConformance` covers the
`DocumentPins` capability beside `DocumentIndex` (tree-backed indexes only;
the legacy row index keeps no pinned list, which is why it is a capability
and not a method on the port). `describeDocumentTrashConformance` covers
the `DocumentTrash` capability (list, restore, purge) the same way, with a
required `evacuatedBlobCount` seam pinning that restore and purge destroy
the evacuated bytes. `describeDocumentDuplicatesConformance` covers
`DocumentDuplicates` (a copy beside its source, named `(copy N)`, numbered
inside the serialised write; a folder on the copy path counts as taken) with
a REQUIRED content seam, since placement alone would pass an empty copy.
`DuplicatingInMemoryDocumentIndex` is the row-backed double's form of it,
given a synchronous content-copy seam, and answers the same suite. `KeyedSerializer` is the one per-key, submission-ordered,
non-poisoning async queue (the index's writes and apps/web's `LoroStore`).

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

`InMemoryDocumentStore` (here, beside `InMemoryDocumentIndex`) is the one in-memory
`DocumentStore` double: it answers the suite above, copies every buffer in and
out, and `server-core`'s `FakeDocumentStore` and `mcp-server`'s memory module
are built on it rather than on a private copy. `doc-ref-key-one-place.test.ts`
in `arch-lint` fails on a second spelling of the stored key.

`docRefKey` lives here for the same reason. It is a STORED key, and two
stores that spell it differently cannot read each other's documents — with
nothing to say so at compile time. `workspaceIdOfStoredDocKey` is its exact inverse (the sync wire key is another
grammar, daemon-client's `sse-stream-hub.ts`), and
`doc-ref-key-one-place.test.ts` fails on any other spelling of the key outside
ports (frozen migrations skipped).

## Tests

- Vitest project: `ports-node` (registered in root
  `vitest.config.ts`).
- Every schema has accept + reject example tests; `chunkSnapshot`/
  `reassembleSnapshot` also have fast-check round-trip and
  order-independence properties (`src/snapshot-helpers.properties.test.ts`).
- `src/smoke.test.ts` imports the package by its published specifier
  (`@kamiazya/whiteboard-ports`), not a relative path, to exercise
  `package.json` `exports` resolution the way a real consumer will.

## Common mistakes (append as review finds them)

- Adding a hand-written interface next to a schema instead of `z.infer`.
- Hardcoding an implementation's chunk-size cap into `chunkSnapshot`
  instead of taking it as a parameter.
- Treating an out-of-order chunk set as a `reassembleSnapshot` failure —
  it is a success case.
