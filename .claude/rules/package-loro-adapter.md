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

- **A note's name from its heading** (`name-from-title.ts`, with
  `title-from-body.ts`): the one judgement both keepers run —
  `seedNameFromTitle` by id for the browser store's pushes,
  `writeDocumentContentAndName` for every whole-content write either keeper
  makes (the daemon's tools, `/api/v1` and restore, and the browser's restore),
  `seedNamesFromTitles(since)`
  for the daemon's workspace update, which reads the touched nodes off the
  update's operations rather than walking the tree (135 ms at 1000 documents).
  A name somebody CHOSE carries `nameChosen: true` in the node meta, written
  only by `workspace-tree.ts`'s name writers (`setChosenName`) and cleared with
  the name; the seeder never writes it nor replaces a marked name. Without it
  "Weekly" under `# Weekly review` read as a half-typed heading. Unmarked names
  keep the prefix-follow, old records are not migrated, and an OKF `title`
  equal to the stored name is not a choice (server-core's `applyOkfTitle`).
- **A duplicate is one record change** (`workspace-duplicate.ts`), written
  through the projection rather than `copyNodeData`, so the source's id,
  segment, name, timestamps and plane keys stay behind.
- **A stored plane key is skipped, never read.** The branch's `plane:` child map
  on a document's node is gone with the branch (ADR-0029), but a record
  written then still carries it, so `projectWorkspaceDocument` and
  `writeWorkspaceDocumentContent` skip every `plane:`-prefixed key rather than
  carry it into the document and write a stale copy back.
  `workspace-tree.stored-plane-key.test.ts` holds both.

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
- **`containers.ts` holds the `DocumentContainers` seam and every container
  key.** The content bridge is four modules by what they read: the spatial
  canvas and its locks (`loro-bridge.ts`), the document envelope — kind,
  core, trust and extension facets (`document-envelope.ts`) — the markdown
  body (`markdown-body.ts`), and the read-only lifts of the two shapes older
  writers left (`legacy-lifts.ts`). Each reaches for a key here and never
  for a sibling's, which is what keeps them, `comment-threads` and
  `proposals` from forming a value cycle `cycle-check.ts` would fail on;
  `markdown-body` is the one that imports `loro-bridge`, since a body
  written as a node is read through the canvas and writing one empties it.
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
  than of anything on it — today `facets` and `tags` (ADR-0040), each under a
  key of its own. Separate
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

- **A record written before [ADR-0038](../../docs/contributing/adr/0038-ocif-projection.md)
  decision 3 stored what a node SHOWS as a kind plus that kind's own field**
  — `{ type: 'text', text }`, `{ type: 'file', file, subpath? }`,
  `{ type: 'link', url }`, `{ type: 'group', label? }`. `nodeToFields` writes
  one `resource` now, and `liftLegacyNodeKind` converts a stored node on the
  way out; `liftStoredNode` composes it with the ADR-0037 lift below, in the
  order the record acquired the two shapes.

  Load-bearing for the same reason and by the same mechanism: the model is
  `.strict()` and names neither `type` nor any kind's content field, so such
  a node FAILS its schema and the read drops what fails —
  `legacy-node-kind.test.ts` measures it, and no other test in the package
  can, because every one of them asserts on a document this version wrote.

  It costs bytes, and the scoreboard says how many: 156960 -> 184960 over
  1000 edits (+18%, ~28B), because a text edit used to write one flat key and
  now writes a nested `{ mimeType, content }`. Recorded rather than absorbed
  — it is what a discriminant on the resource would have to beat if that
  question is ever reopened.

- **The retired Excalidraw `elements` list is carried, never read.** `content-sync`
  copies it through as a value so a save loses nothing, but no reader consumes
  it: counts, file GC and export treat a document holding only it as empty. Do
  not add one, and do not probe for it with `getMovableList('elements')`, which
  creates the root container as a side effect.

- **A record written before [ADR-0037](../../docs/contributing/adr/0037-model-and-format.md)
  stored all of this under the FORMAT's extension key**, because the model
  was the format. `liftLegacyExtension` converts a stored node or edge on
  the way out and `readCanvasFacets` falls back to the old envelope, both
  spelling the literal as it stood — the way a migration's own text always
  does. Every write uses the model's names, so a record converges the first
  time anything saves it.

- **A document's content by kind is `readDocumentContent(doc, entryKind?)`,
  nowhere else.** The document's own recorded kind wins, then the entry's,
  then spatial, because spatial is the only kind that existed before kinds.
  `tools/arch-lint`'s `document-content-one-place.test.ts` fails a file
  outside this package that reads both halves unless it is ledgered with a
  reason.

- **An edit that started from a read applies `reconcileFacets` /
  `reconcileCoreFacets` (or `reconcileSpatialCanvas`), never
  `writeFacets` / `writeCoreFacets`.** The write forms replace the stored
  bucket outright, so a concurrent edit to a field the caller did not touch
  is lost; the reconcile forms diff against what the caller last read.
  `document.set` is the only wholesale replacer, and
  `spatial-canvas-write-one-place.test.ts` enforces it for the canvas.

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
- `readSpatialCanvas`/`writeSpatialCanvas` tests: round-trip a node of each
  resource kind and the frame, edges, a node's embed and every facets bucket,
  overwrite/delete semantics, and CRDT merge of independent node additions.
- `loro-bridge.property.test.ts` draws canvases from the model schemas and
  round-trips nodes, edges AND the canvas's own facets — the last because
  this bridge is the path the app saves through and a JSON round-trip is no
  evidence a field persists here.
  Mutation-checked: dropping a node's `subpath`, a group's
  `backgroundStyle`, an edge's `label` or the envelope's `facets` in the
  write path each turns it red — and a node's `tags`, which it reported on
  the day the field arrived, before `nodeToFields` carried it. The board's
  own `tags` get their own equality beside `facets`, since a node's failure
  says nothing about the envelope.

## Common mistakes (append as review finds them)

- Importing `node:*` or DOM globals in a shared-layer package.
