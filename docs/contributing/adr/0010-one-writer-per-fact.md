# ADR-0010: One writer per fact, and SQLite as a derived index

**Status:** Proposed

## Context

A document's kind was recorded in two places that disagreed, and each layer
applied the opposite policy to a missing value. Measured against this
checkout's own data:

| document | `canvases.kind` column | Loro `document.kind` | nodes |
|---|---|---|---|
| `Go1G4OcJKUBu` | `null` | absent | 75 |
| `uH6qTx6Ai2hl` | `spatial` | **absent** | 92 |

The Loro map was empty for every document that existed, including the one the
column had an answer for. `wb_document_get` reads the Loro map and refused;
`listCanvases` read the column and answered `spatial`; `getCanvasKind`
invented `spatial` and restore stamped that invention onto a restored
document's row, where it outlived the guess.

The instructive part is not that a value was wrong. It is that **no layer was
wrong on its own terms**. Refusing an unknown kind is correct for a read that
must pick a format. Defaulting to `spatial` is correct for a list that renders
a badge. They were both reasonable because nothing said which of them owned
the fact.

### The same shape, twice more

- **A document's name.** [ADR-0009](0009-mcp-tool-naming.md) already noted it
  is stored twice. The writers are independent: `renameCanvasSlug` updates
  `canvases.slug` and never touches the workspace tree, while `canvas-crud`
  creates and reads the tree's `segment` and never touches the column.
- **Placement vs. listing.** The workspace tree is already a Loro document
  (`docRef: { kind: 'workspace-tree', workspaceId }`), so the index is
  *already* partly a CRDT. The situation was never "SQLite versus Loro" — it
  is three homes, with facts scattered across them by history rather than by
  rule.

[ADR-0007](0007-canvas-identity-and-store-split.md) split the stores,
[ADR-0008](0008-slug-derivation-and-rename.md) hit the wall with alias
history, and ADR-0009 hit it again with format. Three ADRs meeting the same
wall is evidence about the rule that is missing, not about the split.

### Why the storage engine is not the problem

Collapsing everything into one large Loro document is the obvious-looking
fix and is rejected here on this codebase's own evidence:

- **Listing would have to load content.** Today a list is
  `SELECT slug, updatedAt, kind`, served by the `canvases_workspace_updated_idx`
  index. A CRDT has no `ORDER BY updatedAt LIMIT n`; sorting, filtering and
  paging all become in-memory scans over every document's content.
- **Op-log growth is already a fight.** `compactCanvas`, the 32 MiB
  `SNAPSHOT_WARN_BYTES` warning and the auto-compact debouncer exist because
  a Loro document accumulates history. One document holding everything fights
  that battle in a single file that every write touches.
- **One lock for everything.** `withWorkspaceWriteLock` serialises per
  workspace. A single document serialises the product.

None of those costs are what caused the bug. Two stores did not cause it
either — **two independent writers did**.

## Decision

### 1. Every fact has exactly one owner

The owner is the only thing that may write it. Everything else derives.

| fact | owner | derived copy |
|---|---|---|
| content (nodes, edges, facets, body) | the document's Loro document | — |
| `kind` | the document's Loro document (ADR-0009: format follows from the document) | `canvases.kind` |
| placement (`segment`, parent, derived alias) | the workspace-tree Loro document | `canvases.slug` |
| `isPinned`, `pinOrder` | `canvases` | — |
| `currentBranch` | `canvases` | — |
| `createdAt`, `updatedAt` | `canvases` | — |

Facts with a single home stay where they are. This ADR moves nothing that is
not currently duplicated; a rule that relocates working code for symmetry is
cost without a defect behind it.

### 2. SQLite `canvases` is a derived index, not a second record

It keeps the job it is good at — indexed queries for listing, sorting and
paging — and loses the job it was accidentally doing. Concretely:

- One projection function writes the derived columns, called on save inside
  the existing `withWorkspaceWriteLock`. No other call site writes them.
- The index is **rebuildable from the documents**. Drift is a repair, not a
  loss, which is what makes a cache safe to depend on.

### 3. An unrecorded kind is not representable

Backward compatibility, including for stored data, is explicitly not a
consideration at 0.0.x. So the kind-less state is removed rather than
handled: `kind` is required at creation and the column is `NOT NULL`. Code
that exists only to cope with documents predating kinds is deleted, not
migrated — see Consequences.

### 4. Unknown-because-legacy and unknown-because-newer are different

`readDocumentKind` returns `undefined` for two unrelated reasons: a document
written before kinds existed, and a kind a *newer peer* wrote that this build
does not recognise. Decision 3 eliminates the first. The second is **forward**
compatibility and survives — a CRDT that syncs between versions must be able
to say "a peer knows something I do not" and refuse rather than guess.

### 5. The rule is executable, not prose

"Only the projection writes `kind`" is checkable by a test that scans for
writes to the derived columns outside the projection, in the same spirit as
`tools/arch-lint`. A convention that only lives in an ADR is the convention
that produced the table at the top of this document.

## Consequences

**This deletes code.** Once an unrecorded kind cannot exist, the machinery
built to survive it is unreachable and goes:

- the "declare a kind on first write" branches in `wb_node_add`,
  `wb_edge_add` and `wb_document_set`
- `DocumentContentLossError` and the markdown-shape check guarding it
- `DocumentKindUnknownError`'s legacy half (its newer-peer half stays, per
  decision 4)

Those guards were correct for the policy in force when they were written —
they stopped `wb_document_set` flattening a 75-node diagram. Under a policy
that discards legacy data outright they are answering a question that no
longer gets asked.

**Reads get simpler and writes get one more step.** A consumer stops choosing
a fallback, because there is nothing to fall back from. A writer must go
through the projection instead of setting a column, which is the cost being
bought.

**Drift becomes possible where duplication was.** A crash between the document
save and the index update leaves them out of step. That is strictly better
than disagreement: both are inside the workspace write lock, and the rebuild
path makes it recoverable, whereas two independent writers produce a conflict
nothing can adjudicate.

**Sync gets an answer it did not have.** SQLite does not sync; Loro does.
Putting owned facts in the CRDT means workspace metadata can converge across
peers when that is needed, without a second design.

Not included here: the order in which this lands. That is what `gh stack`
manages, per `.claude/rules/dev-flow.md`.

## Alternatives considered

**One large Loro document for everything.** Rejected on measured cost:
listing would load all content, op-log growth would concentrate in one file,
and every write would take one lock. It also would not have prevented the
incident, which was caused by two writers rather than by two stores.

**Keep both writers, add discipline.** This is the status quo, and the table
at the top of this document is its result. Three ADRs have now met the same
wall; a fourth reminder is not a different outcome.

**Make the reads agree instead of the writes** — have every reader apply the
same default. It removes the visible disagreement while keeping the cause,
and it standardises on a guess: a document that predates kinds is more likely
spatial, but a markdown one restored as spatial opens in the wrong editor and
stays that way. ADR-0009 already rejected inferring format from content for
the same reason.
