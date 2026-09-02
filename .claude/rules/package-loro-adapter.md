---
paths:
  - "packages/loro-adapter/**"
---

# loro-adapter — LoroDoc<->model bridge

The name states what it adapts. It is NOT an adapter of `ports` — it
implements no port and does not depend on that package; the store/sync port
implementations live in the composition roots.

## What belongs here

- LoroDoc⇔model bridge: the CRDT merge–aware conversion deferred from
  codec. Reading and writing a document's content — spatial canvas,
  document kind, core facets, body.
- **The workspace tree** (`workspace-tree.ts`): a workspace as ONE Loro
  document, with each document it holds as a node of a `LoroTree` whose
  meta carries that document's own containers.

  This is a boundary that MOVED, and the paragraph below used to say the
  opposite. It said placement belongs to `ports`' `DocumentIndex` and that
  this package "knows a document's content and nothing about where it
  sits" — a clean split, and the right one while a workspace was an index
  beside a pile of separate Loro documents.

  The workspace-document design retires that split rather than bending it:
  placement and content become the SAME CRDT structure, which is what lets
  a move on one peer and an edit on another merge with no coordinator.
  There is no longer a "where it sits" separable from the document, so
  there is nothing left for the old boundary to divide. Deriving a path
  from a node's ancestry is reading the tree, not implementing a port.

  What did NOT move is the port: `DocumentIndex` is still implemented by
  each composition root, still owns the listing ORDER
  (`compareDocumentPaths`) and the error taxonomy, and now reads the tree
  instead of its own rows.

## What does NOT belong here

- The `DocumentIndex` port itself, or its ordering and error contracts.
  `readWorkspaceDocuments` deliberately answers in TREE order and does not
  sort: sorting is the port's promise, and importing `compareDocumentPaths`
  would give this package a `ports` dependency for one comparator. The
  shadowing rule needs tree order and nothing else.
- Store/sync **implementations** (local libSQL/fs, IndexedDB, Durable
  Objects) — those live in composition roots (`mcp-server`, `apps/web`).
- HTTP routes, MCP tool definitions — those live in `server-core` or
  `mcp-server`.
- Scene graph, layout, rendering — `canvas-render`.
- InversifyJS or any DI container wiring — composition roots only.

## Dependency rules

- Runtime dependencies: `model`, `loro-crdt`, and `zod` (all via `catalog:`
  or `workspace:*`). **Still not `ports`**, even now that the workspace tree
  lives here — the one thing that tempted it was `compareDocumentPaths`, and
  that belongs to the port's contract rather than to the tree. `architecture-
  map.ts` enforces this; note the top-level `architecture-map.md` table has
  listed `ports` for this package for some time and is wrong about it.
- Forbidden imports: `node:*`, DOM globals (`document`/`window`/`navigator`),
  `inversify`.
- Enforced by `tools/arch-lint` (`arch-lint-node` vitest project).

## Conventions

- Every mutation calls `doc.commit()` after writing, so incremental
  exports (`mode: 'update'`) capture the change boundary.
- The content bridge takes a `DocumentContainers`, not a `LoroDoc`. The two
  storage models differ in WHERE a container is found and in nothing else —
  a root of the document, or a key on a tree node's meta — so the bridge is
  written once and hosted twice. `LoroDoc` satisfies the interface
  structurally, which is why the move cost no call site a change.
- A tree-node host uses `getOrCreateContainer`, never `setContainer`. The
  latter REPLACES what is at the key: measured, a second `setContainer` on
  an occupied key leaves `{}`, so writing a document twice would wipe it.
- LoroDoc spatial layout: `doc.getMap('nodes')` keyed by nodeId,
  `doc.getMap('edges')` keyed by edgeId. Each value is a plain object
  (not a nested LoroMap container) — this preserves node-level CRDT
  merge while avoiding Loro's nested-container overwrite issues.
- **A nested container is the right shape only when the thing inside it must
  merge per ENTRY**, and it buys that at a price worth naming. The annotation
  layer's `threads` map (`comment-threads.ts`, ADR-0026) is the one that
  qualifies: a thread's messages are a set two peers append to concurrently,
  and stored as one value the second reply would erase the first, silently.
  Nodes, edges and comments are each ONE value with one meaning, so a plain
  object is right for them and a container would only add the hazard below.

  The price, measured on loro-crdt 1.13.6: when two replicas create a
  container under the same key with **no common ancestor for that key**, the
  merge keeps one of them and every entry the other side put in it is gone —
  no conflict, no marker. So only the CREATION path may open a thread
  container (its id is minted, and cannot collide); a reply or a status change
  to a thread this replica has not received writes nothing rather than opening
  a rival. `setContainer` is banned here for the reason it is banned on tree
  nodes, and `getOrCreateContainer` alone is not enough.
- A third map, `doc.getMap('canvas')`, holds the canvas ENVELOPE —
  properties of the canvas rather than of anything on it (today
  `x-whiteboard`, the rendering preferences). Separate because the merge
  story differs in kind: nodes and edges are keyed per object so two peers
  editing different objects both survive, whereas a canvas-wide preference
  is one value with one meaning and last-writer-wins per key is all it
  needs. Anything the canvas carries beside `nodes`/`edges` must be written
  here — a schema round-trip through JSON is NOT evidence it persists,
  since this bridge is the path the app actually saves through.

## Tests

- Vitest project: `loro-adapter-node` (registered in root
  `vitest.config.ts`).
- Unit tests for CRDT merge behavior across the bridge.
- `readSpatialCanvas`/`writeSpatialCanvas` tests: round-trip all node types
  (text/file/link/group), edges, x-whiteboard extensions, overwrite/delete
  semantics, and CRDT merge of independent node additions.

## Common mistakes (append as review finds them)

- Importing `node:*` or DOM globals in a shared-layer package.
