# search — lexical search over documents

## What belongs here

- The tokenizer: latin runs lowercased as words, CJK runs as adjacent
  character bigrams (`tokenize`). Dictionary-free by design — Japanese,
  Chinese and Korean all work with zero download, trading precision for
  recall the way every dictionary-free engine does.
- BM25 ranking over a caller-supplied corpus (`fullTextSearch`), plus the
  match excerpts a result row shows (`snippetAround`).
- **The one definition of what text a document contributes**
  (`searchableTexts`): a markdown body, or a canvas's node texts, group
  labels and edge labels.

## What does NOT belong here

- Reading a document. This package takes content ALREADY read — a body, or
  a `SpatialCanvas` — which is why it needs neither `loro-crdt` nor the
  bridge, and why it runs unchanged in a worker.
- Persistence, indexes, caches. The daemon serves its corpus from
  `ContentFactsCache`; the browser builds one from IndexedDB. Where the
  corpus comes from is the caller's business.
- Query UI, debouncing, result rendering (`apps/web`), and the HTTP/MCP
  surfaces (`server-core`).

## Dependency rules

Runtime dependencies: `@kamiazya/whiteboard-model` (types only). Forbidden:
`node:*`, DOM globals, `inversify`, `loro-crdt`, `zod`. Enforced by
`tools/arch-lint` (`arch-lint-node`).

## Why it is its own package

The daemon and the browser must answer a query the same way. A second copy
of the ranking — or of the corpus definition — is a second set of answers,
and the difference shows up as one mode finding a document the other
cannot. `server-core` cannot be that home: it carries hono and the whole
`/api/v1` surface, and the browser has no business importing a package
whose ROLE is the server.

## Conventions

- `fullTextSearch` scores are comparable **within one response only** —
  BM25 is corpus-relative. Never persist or compare them across calls.
- Each searchable text stays a separate string so a snippet can say which
  source matched; joining them would splice unrelated sentences.
- An empty query answers nothing rather than everything, matching
  `search-documents.ts` in apps/web: the caller decides what "no query"
  shows.

## Tests

- Vitest project: `search-node`.
- The tf-monotonicity property (more occurrences never lower a score) is
  the one algebraic invariant BM25 offers cheaply; the rest are examples,
  including the CJK bigram shape and the snippet window.

## Common mistakes (append as review finds them)

- Reaching for a LoroDoc parameter "because the caller has one". It drags
  the CRDT into a package that is otherwise pure, and every caller already
  holds the body or the canvas.
