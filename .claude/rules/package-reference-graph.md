---
paths:
  - "packages/reference-graph/**"
---

# reference-graph — what the documents of a workspace point at

## What belongs here

- **What one document contributes** (`extractContentFacts`): the references
  its content writes (`[[path]]`, `![[path]]`, a file node's target), the
  texts search and mention-finding read, and its tag bearers. Pure over plain
  values (`ContentWithTags`: the content a keeper read, plus a note's own tags);
  no CRDT engine reaches this package, so a keeper reads, and this derives. `tagBearersOf` and `splitBearerTags` are
  exported on their own, so the daemon's projection and the browser keeper
  count the same bearers rather than each walking a canvas by hand.
- **What the graph answers** (`ReferenceAggregate`, `mentionsOfIn`,
  `unlinkedNameSpans`): backlinks and unlinked mentions, computed from those
  facts. The aggregate is the one query engine, fed one upsert per listed
  document by `backlinksIn`; there is no event feed.
- **The digest-validated cache** (`ContentFactsCache`): facts kept between
  reads and re-extracted only for a document whose listing `contentDigest`
  moved. The digest is a hash of the MERGED content, computed at read time by
  the same function on both keepers, so correctness depends neither on
  hooking every write path nor on any replica's word about when it wrote.
- **What a rename does to a referring document**
  (`planDocumentReferenceRewrite`): codec's plan turned into a `DocumentEdit`
  from the document's content, so both keepers repoint a reference with one
  function. Applying (`applyDocumentEdit`, loro-adapter's) and saving stay the
  keeper's.
- **What Link does to a source** (`planLinkifyMentions`, `linkMarkupFor`):
  turning a document's unlinked mentions of another into a `DocumentEdit`,
  so the same planner serves a standalone document on the daemon and a node of
  the browser's workspace record. Applying and saving stay the keeper's. A
  markdown body is planned as descending splices so a concurrent edit
  elsewhere merges; a board as a diff of `after` against the canvas read, since
  handing a full resync `{ nodes, edges }` once deleted every line and tag.
- **One port, `DocumentContentSource`** — what the listing cannot give the
  cache: the document's content (`loadContent`, null when nothing is stored),
  and OPTIONALLY a version per document for a listing entry with no digest.
  The daemon supplies both (`server-core`'s `factsCacheFor(deps)`, whose
  fallback is a live document's frontier — its in-memory test index lists no
  digests). The browser supplies only the load, because every listing it
  makes carries a digest. A digest-less entry with no keeper version is
  re-read every time: the listing's own contract for an absent digest is
  "must not memoise".

## What does NOT belong here

- **Anything a keeper derives from content with a capability of its own.**
  A document's search VECTOR is the daemon's (`server-core`'s
  `DocumentVectorCache`): embedding is a runtime capability, and a vector
  field here would be one the browser keeper never fills. Such a cache keys
  on `ContentFactsCache.stampOf` rather than a stamp of its own, so there is
  still ONE answer to "has this document changed" — and an edit invalidates
  the facts and everything derived from them in the same breath.
- **Applying a rename's rewrite** (`followReferencesAfterRename`). Finding
  candidates, loading and saving are an operation of whoever keeps the
  documents, so that stays in `server-core` (and in the browser files
  source); the rewrite itself is `planDocumentReferenceRewrite`, above.
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
- `reference-aggregate.property.test.ts` holds the aggregate's
  order-independence over a listing and its backlinks against an independent
  inverse-of-forward-references oracle.
