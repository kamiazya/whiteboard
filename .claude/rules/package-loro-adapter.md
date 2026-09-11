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

- **A document's PLANES** (`openWorkspaceDocumentPlane` /
  `readWorkspaceDocumentPlane`): a named child map on a document's tree node,
  for state that belongs to the document without being one of
  `workspaceNodeMetaSchema`'s fixed scalars. The branch plane is what it
  exists for; `updateWorkspaceDocumentMeta`'s patch is `.strict()` precisely
  so a growing collection cannot be smuggled in as a meta field.

  Mergeable, and the primitive lives here rather than at the call site for
  that reason: nothing pre-attaches a plane, so the first replica to use one
  opens it, and two replicas doing that independently is the ordinary case.
  The READ never opens — opening writes an activation marker, so a read that
  created the plane would grow the record of every document anybody merely
  looked at. `workspace-tree.plane.test.ts` holds both, the second by
  asserting the snapshot is byte-identical across a read.

  A plane is outside `CONTENT_CONTAINER_KEYS`, so writing one does not move
  the document's `contentDigest` — a branch tip recorded on every save would
  otherwise invalidate every cached picture of the document.

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
- A tree-node host opens containers through `mergeable-containers.ts`, never
  `setContainer`. The latter REPLACES what is at the key: measured, a second
  `setContainer` on an occupied key leaves `{}`, so writing a document twice
  would wipe it. The one place `setContainer` is right is `copyNodeData`,
  whose target is a node `createNode()` just minted — replacing on an empty
  node replaces nothing, and it is what copies a container by KIND without a
  hardcoded list of keys. A document's own content containers stay REGULAR children
  deliberately — pre-attached at creation, so no replica opens one first, and
  mergeable would cost 18.6% of the delta log to close a hazard that is
  already closed (`mergeable-containers.test.ts` carries the numbers).
- LoroDoc spatial layout: `doc.getMap('nodes')` keyed by nodeId,
  `doc.getMap('edges')` keyed by edgeId. Each value is a plain object
  (not a nested LoroMap container) — this preserves node-level CRDT
  merge while avoiding Loro's nested-container overwrite issues.
- **The threads and proposals planes are the exception: each entry IS a
  nested container** (mergeable, so two peers replying at once converge),
  and the workspace record has to carry it as one. `syncMapEntries` in
  `workspace-tree.ts` is the one map-entry sync the fold, the projection,
  `copyNodeData` and `reconcileDocContent` all go through, and it recurses
  into a container where the source has one instead of `set`ting its
  `toJSON()`. Before it, a thread went into the record as a value and came
  back after a restart as one — the reader skipped it, the writer threw
  `Expected value type Map but found Value(Map)` — and no in-process test
  saw it, because the projection is per-process and only a reopen
  re-projects. `comment-threads.durability.test.ts` and
  `proposals.durability.test.ts` cross that reopen; a new plane whose
  entries are containers gets a test of the same shape.
- **`containers.ts` holds the `DocumentContainers` seam and the container keys
  more than one module reads.** A key lives in `loro-bridge.ts` until a second
  module needs it and moves here then — which is also what keeps `loro-bridge`
  and `comment-threads` from importing each other, a value cycle
  `cycle-check.ts` would fail on.
- **A comment lives in the `threads` plane (ADR-0026), and `readSpatialCanvas`
  PROJECTS one back.** Every writer — `writeCanvasComment`, the resync inside
  `writeSpatialCanvas`, `withSpatialBatch` — goes through the thread plane, so
  the canvas API every consumer speaks is unchanged while the storage under it
  moved once rather than twice. The projection is lossy by construction (a
  thread's replies have nowhere to go in a `CanvasComment`, and a text anchor
  has no canvas position), which is why the panel that shows a conversation
  reads threads directly instead.

  The legacy `comments` map is read as a FALLBACK, for a document no writer has
  touched since. `migrateCanvasCommentsToThreads` empties it at every write
  seam, and it does not commit — the seam that calls it owns the commit
  boundary, because an extra commit inside `withSpatialBatch` splits one user
  action into two undo steps. Retire the fallback (and `COMMENTS_KEY`) once
  nothing needs it; the condition is a keeper whose documents have all been
  written since.
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
  no conflict, no marker.

  A thread's key does NOT protect against that, and the claim here that it
  did ("its id is minted, and cannot collide") was wrong: the key is the
  CALLER's comment id, which `writeCommentInto` passes straight through and
  `deleteCommentInto` looks the thread up by. Two keepers migrating the same
  legacy comment, or each applying one `comment.add`, reach the same key
  having never seen the other's. `openMergeableMap`
  (`mergeable-containers.ts`) is what closes it — a deterministic child id,
  so the two were editing one container all along — and
  `comment-threads.convergence.test.ts` is the measurement. Which containers
  are mergeable and what the choice costs in oplog bytes is the
  `loro-crdt-usage` skill.

  Creation is still the only path allowed to OPEN a thread container, now for
  intent rather than convergence: a reply to a thread this replica does not
  hold would otherwise materialise an anchorless, statusless thread around it.
  `setContainer` is banned here for the reason it is banned on tree nodes.
- **A proposal lives in the `proposals` plane (`proposals.ts`, ADR-0029),
  shaped like `threads` and nested for a different reason.** A proposal
  container holds its provenance beside a map of CHANGES keyed by change id,
  so two people deciding different parts of one proposal at once is a merge
  with nothing to resolve. Inside that map a change is a PLAIN VALUE, not a
  container: the extra level a thread needs buys nothing here, because the
  only write after a change is created is a verdict, and two verdicts on two
  changes are already two keys. What would change that answer is a change
  whose payload becomes editable — a person adjusting a proposed geometry
  before adopting it — and that is when `status` earns a key of its own.

  `openMergeableMap` for the proposal container itself, for exactly the reason
  a thread needs it: the key is the caller's proposal id, so two keepers can
  reach the write having never seen each other's. Creation is still the only
  path allowed to open one — a verdict on a proposal this replica does not
  hold would materialise a headless record around a decision nobody made.

  `PROPOSALS_KEY` is in `CONTENT_CONTAINER_KEYS`, so a pending proposal MOVES
  the document's content digest and a listing shows the document as having
  changed. That is the intended reading rather than a side effect, and it is
  the opposite call from the branch plane's (outside the set, because a tip
  recorded on every save would invalidate every cached picture). The price is
  pinned: `workspace-record-growth.test.ts` measures 919 -> 950 bytes at one
  document and 14860 -> 16082 at fifty.

- A third map, `doc.getMap('canvas')`, holds properties of the canvas rather
  than of anything on it — today `facets`, under a key of its own. Separate
  from nodes and edges because the merge story differs in kind: those are
  keyed per object so two peers editing different objects both survive,
  whereas a canvas-wide preference is one value with one meaning and
  last-writer-wins per key is all it needs. Anything the canvas carries
  beside `nodes`/`edges` must be written here — a schema round-trip through
  JSON is NOT evidence it persists, since this bridge is the path the app
  actually saves through.

- **An edge's ENDPOINT is one value too**, for the reason `bends` is and one more: the two arms of
  the union share only `end`, so an end that is a node in one replica and a point in another has
  no field-wise merge that means anything. Writing the whole endpoint under one key makes the
  merge the "whoever wrote last placed this end" a reader expects.
  `-0` does not survive the record here either, and a free end's `point` is its THIRD home — the
  node's `x`/`y` and an edge's `bends` are the other two. Each was found by
  `loro-bridge.property.test.ts` on the day its field arrived, which is the argument for keeping
  the property rather than only the three examples beside it.

- **An edge's `bends` are ONE value, not a nested container.** Last-writer-wins per key is what a
  dragged path wants: two people reshaping one edge concurrently should converge on a path one of
  them drew, never on an interleaved third neither did. `loro-bridge.property.test.ts` is what
  says it persists at all — it reported the field dropped before `edgeToFields` carried it, which
  no other test in the suite could have seen.

- **A record written before [ADR-0035](../../docs/contributing/adr/0035-model-and-format.md)
  stored all of this under the FORMAT's extension key**, because the model
  was the format. `liftLegacyExtension` converts a stored node or edge on
  the way out and `readCanvasFacets` falls back to the old envelope, both
  spelling the literal as it stood — the way a migration's own text always
  does. Every write uses the model's names, so a record converges the first
  time anything saves it.

  This is load-bearing, not tidy. The model is `.strict()` now, so a stored
  node still carrying the old key FAILS its schema and the read drops what
  fails: measured in `legacy-extension.test.ts`, removing the lift makes
  both nodes VANISH (`[]` where `['n1','n2']` is expected) rather than lose
  a field. Nothing else in the suite can see that — every other test
  asserts on a document this version wrote.

- **A delete is an oplog op even when the key was never there.** Both the
  facets write and the legacy cleanup check before deleting, and that is
  not micro-optimisation: the write path used to delete the canvas envelope
  on EVERY save, including the overwhelming majority of saves on boards
  that never had one. Removing it cut delta-log growth 178660 -> 156960
  bytes over 1000 edits (-12%, ~22B per edit) and the stored snapshot
  11699 -> 11040. `workspace-record-growth.test.ts` is the only thing that
  could say so — no correctness test can see an op that costs bytes and
  changes no state.

## Tests

- Vitest project: `loro-adapter-node` (registered in root
  `vitest.config.ts`).
- Unit tests for CRDT merge behavior across the bridge.
- `readSpatialCanvas`/`writeSpatialCanvas` tests: round-trip all node types
  (text/file/link/group), edges, a node's embed and every facets bucket, overwrite/delete
  semantics, and CRDT merge of independent node additions.
- `loro-bridge.property.test.ts` draws canvases from the model schemas and
  round-trips nodes, edges AND the canvas's own facets — the last because
  this bridge is the path the app saves through and a JSON round-trip is no
  evidence a field persists here.
  Mutation-checked: dropping a node's `subpath`, a group's
  `backgroundStyle`, an edge's `label` or the envelope's `facets` in the
  write path each turns it red.

## Common mistakes (append as review finds them)

- Importing `node:*` or DOM globals in a shared-layer package.
