---
paths:
  - "packages/reference-graph/**"
---

# reference-graph — what the documents of a workspace point at

## What belongs here

- **What one document contributes** (`extractContentFacts`): the references
  its content writes (`[[path]]`, `![[path]]`, a file node's target), the
  texts search and mention-finding read, and its tag bearers. Pure over a
  listing entry and a `LoroDoc`.
- **What the graph answers** (`ReferenceAggregate`, `mentionsOfIn`,
  `unlinkedNameSpans`): backlinks and unlinked mentions, computed from those
  facts. The aggregate is the one query engine; an event feed, if one lands,
  fills the same structure rather than becoming a second answer.
- **The frontier-stamped cache** (`ContentFactsCache`): facts kept between
  reads and re-extracted only for a document whose persisted frontier moved.
  Correctness does not depend on hooking every write path — any writer moves
  the frontier, and the next read catches it.
- **One port, `DocumentContentSource`** — the two reads the cache cannot do
  itself (a document's frontier bytes, and the document). Each keeper writes
  one: the daemon over its document store (`server-core`'s
  `contentSourceFromDeps`), the browser over IndexedDB.

## What does NOT belong here

- **Anything a keeper derives from content with a capability of its own.**
  A document's search VECTOR is the daemon's (`server-core`'s
  `DocumentVectorCache`): embedding is a runtime capability, and a vector
  field here would be one the browser keeper never fills. Such a cache keys
  on `ContentFactsCache.stampOf` rather than a stamp of its own, so there is
  still ONE answer to "has this document changed" — and an edit invalidates
  the facts and everything derived from them in the same breath.
- **Rewriting references** (`followReferencesAfterRename`). It WRITES
  documents, so it is an operation of whoever keeps them; it stays in
  `server-core` and reads its candidates from this package's cache.
- **Tool surfaces and routes** (`computeBacklinks`, `wb_document_search`).
  They are the daemon's answers to a request and compose what is here.

## Why it is its own package

It grew inside `server-core`, which is fine while one keeper asks the
questions. The browser keeper asks them too (its Connections panel), and
`server-core` brings `hono` and the daemon's whole tool surface with it — so
the choice was a second definition of "what links here" in `apps/web`, or
this. A second definition is the failure `architecture-map.md` keeps
recording: two answers that drift with every test green.

## Tests

- Vitest project: `reference-graph-node`.
- `content-facts-cache.test.ts` holds the cache over a FAKE port — reuse
  while the frontier bytes hold, reload when they move, the kind as part of
  the stamp, a document whose content went away, eviction — each
  mutation-checked. The same cache over the daemon's real stores stays in
  `server-core` (`references/content-facts-cache.test.ts`), beside the
  command-model property (`reference-semantics.property.test.ts`) that
  checks the cached answers against a fresh scan after every command.
- `reference-aggregate.property.test.ts` holds the aggregate's convergence
  under shuffled, duplicated event streams.
