# ADR-0007: Canvas identity and the daemon's two-store split

**Status:** Accepted

> **Vocabulary note (2026-08-17):** read **OpenCanvas** as **Document** everywhere
> below. It was this project's own working name for the post-Excalidraw
> document world, never a spec — the FORMATS are OKF Markdown and
> [JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/), and
> [ADR-0009](0009-mcp-tool-naming.md) named the entity `Document`. The word is
> retired from prose, manifests and identifiers; this ADR keeps it because a
> decision record is history, and rewriting the reasoning would misreport what
> was decided.

> **Vocabulary note (2026-08-16):** this ADR predates [ADR-0009](0009-mcp-tool-naming.md)
> and says **slug** throughout for what the code, the database column, the URLs
> and the docs now all call a document's **path**. The identity decision itself
> stands unchanged — `(workspaceId, path)` is still the canonical user-facing
> identity, and "slug rename" is still the open question it describes. Only the
> word moved. `slug` now fails an executable check
> (`tools/arch-lint/src/vocabulary-check.test.ts`), which is why this note
> exists: a reader arriving here would otherwise meet a banned word in an
> Accepted decision. See `.claude/rules/vocabulary.md`.

## Context

The daemon holds "canvases" in two representations that are co-located in
one SQLite file but share no logical state — no common tables, no common
byte store, and (as detailed below) no shared identity beyond the raw
`workspaceId` string:

- **Workspace/slug store.** Identity is `(workspaceId, slug)` (unique
  constraint `canvases_ws_slug_unq`); rows carry `displayName`, `kind`,
  pins, and branch/version linkage; canvas bytes live as Loro snapshots
  on the filesystem under `blobs/<workspaceId>/canvas/`. Written only by
  the daemon's HTTP API (`/api/workspaces/*`, `/api/canvas/*`), read only
  by `apps/web`. The internal row PK is a nanoid the wire never sees.
- **OpenCanvas doc store.** Identity is a ULID `canvasId` plus a
  `segment` unique among siblings; the human-readable `alias` path is
  derived from segments at read time and never persisted. Canvases and
  the per-workspace tree are Loro docs chunked into SQLite
  (`canvasDocSnapshots*`). Written by every registered MCP tool
  (`wb_canvas_*`, `canvas_import_okf`, node/edge/facet/body patches) and
  by the identical `/api/v1` routes; read by the gallery's tree view.

There is **no bridge by construction**: neither store's write path
touches the other's tables, `server-core` imports nothing from the
legacy store, and no reconcile job exists (`reindexAllWorkspaces` has no
production caller). Empirically: `wb_canvas_create` with
`createWorkspace: true` yields a canvas invisible to
`GET /api/workspaces`, and a canvas created from the web UI is invisible
to `wb_canvas_list`. The only shared token is the raw `workspaceId`
string, which is authoritative in neither.

Meanwhile the third runtime, browser-local, identifies canvases by a
random UUID with no slug and no workspace, and the UI-unification work
(shared canvas list, ADR-0006 creation flow) needed a decided identity
story to build on.

## Decision

1. **`(workspaceId, slug)` is the canonical user-facing canvas identity.**
   URLs, sync, versions, branches, and the shared canvas list all address
   canvases by slug. A ULID/opaque-id-canonical model was considered and
   explicitly not chosen (product decision, 2026-08-11): slugs are what
   users see, share, and reason about, and the daemon's storage already
   enforces their uniqueness per workspace.
2. **Slugs are assigned at creation and are immutable for now — rename is
   deliberately OPEN, not decided.** Creation collects no name up front
   (ADR-0006), so slugs derive automatically (`untitled`, `untitled-2`,
   …) and naming happens afterwards via display names. Making slugs
   renamable is attractive but changes what sync, branches, versions, and
   bookmarks key on; it is deferred pending the slug-as-storage-key spike
   and must not be treated as settled by this ADR.
3. **Browser-local models "exactly one workspace that is always present",
   not the absence of workspaces.** Its canvases keep UUID identity with
   a *derived, cosmetic* display slug that matches the daemon slug
   charset, so a later promotion to real slugs needs no re-derivation.
4. **The two daemon stores are recorded as a known split with a named
   convergence direction: converge on the user-facing world.** The
   workspace/slug store is what users see and what the canonical identity
   (point 1) lives in; the OpenCanvas doc store's agent surface must
   eventually read and write canvases users can see, rather than a
   parallel population. The concrete mechanism (adapter, migration, or
   replacement of the legacy store's internals under the same identity)
   is not chosen here — but any step that widens the split (new features
   landing in only one store's world without a plan to meet the other) now
   requires justification against this ADR.
5. **Prose must stop calling two different things "canvasId".** The
   legacy store's internal nanoid row PK is a storage detail; the ULID in
   the OpenCanvas store is the `canvasId`. Docs and code comments should
   say "canvas row id" for the former.

## Consequences

- The shared `CanvasListView` and both list pages (daemon gallery,
  browser-local) are built on slug-shaped identity, consistent with
  point 1 and 3.
- The gallery's grid and its tree view render **different populations**
  today: the workspace picker lists workspace/slug-store workspaces, and
  feeding one into the tree view honestly reports "no OpenCanvas tree
  yet" when that workspace exists only in the legacy store (`wb_canvas_list`
  and the `GET /api/v1/.../canvases` route now agree with
  `wb_canvas_create` and 404 a never-persisted workspace, instead of the
  tree loader silently falling back to an empty tree). A v1-only
  workspace still never appears in the picker at all — re-sourcing the
  picker from the v1 world is not done, since no v1
  workspace-enumeration endpoint exists. This is the split made visible,
  and it is the first UX debt the convergence direction (point 4) is
  expected to pay down.
- The `workspaceIndex*` tables are write-only in production (their query
  surface has no caller); they must not be described or relied upon as a
  lookup path until something consumes them.
- The slug-rename question stays open with a recorded owner: the
  slug-as-storage-key spike informs it. Anything that would make rename
  harder (new slug-keyed persistence) should be flagged in review.
- Agent/human collaboration on one canvas currently requires both sides
  to use the same surface; documentation states this plainly
  ([domain model](../../explanation/domain-model.md)) rather than
  implying the MCP tools operate on the gallery's canvases.

## Alternatives considered

**Opaque id (ULID) as the canonical identity with slugs as mutable
labels.** Rejected by product decision: it makes rename trivial but
demotes the identifier users actually see and share; every user-facing
surface would need a second lookup step, and the existing daemon
storage, sync, and URL scheme are already slug-keyed.

**Declare the OpenCanvas doc store the canonical world and migrate the
web app onto `/api/v1`.** Not chosen now: the user-facing feature set
(names, pins, kinds, branches, versions, thumbnails, sync) lives in the
workspace/slug store, and the v1 world lacks equivalents; converging by
moving the smaller, newer surface toward the identity users already hold
is the cheaper direction. This remains the plausible long-term shape
*under the same slug identity* — the ADR fixes the identity, not the
final storage engine.

**Build an immediate two-way sync bridge between the stores.** Rejected:
a background reconciler between two live CRDT-backed stores with
different identity schemes is the most complex option and would ossify
the split instead of removing it.

## Addendum (2026-08-12): point 3's promotion rationale is withdrawn

[ADR-0008](0008-slug-derivation-and-rename.md) measured what point 3's
derived display slug actually produces for non-Latin names (mutually
indistinguishable `untitled-N`) and decided that a slug is never derived
from a name. The derivation this point said "needs no re-derivation on
promotion" has been deleted; browser-local rows show the display name
alone until browser-local canvases have real slugs. Point 3's first
sentence — one always-present workspace, UUID identity — stands.

## Addendum (2026-08-18): as-built — the split is closed

Decision 4 named the convergence direction (converge on the user-facing
world) and deliberately left the mechanism open. This records what was
actually built, so a reader does not have to infer it from the migration
log.

**Mechanism chosen: replace the legacy store's internals under the same
identity.** Neither surface moved to the other's identity scheme, and no
sync bridge was built (the ADR rejects that above, and it stays rejected).

- **The tree document is retired.** Migration `0007` adopted every
  `workspace-tree:<workspaceId>` document into the shared `documents`
  table.
- **One id space.** Migration `0008` re-minted every legacy nanoid row as a
  ULID; `0012` swept the rows a third minting site (the version/name/branch
  stores' `upsertCanvasRow`) kept producing until it was fixed to mint
  ULIDs too. Rows created by that site had been invisible to the agent
  surface, which skips non-ULID ids.
- **One byte store.** `document-store.ts`'s `loadDocument`/`saveDocument`
  now read and write the same Libsql snapshot rows the MCP tools use;
  filesystem blobs are no longer a storage location. Migration `0011`
  imports pre-existing blobs additively (divergences are logged, never
  auto-resolved), the daemon re-runs that import at startup to close the
  window between the migration and this change, and a blob file is deleted
  only after its bytes are proven byte-identical to the stored rows.
- **Write locking is unified.** The HTTP/WS save path nests the per-document
  lock the MCP tools take, inside the workspace lock it already held, and a
  save merges the stored snapshot into the outgoing document first — a
  long-lived editing session can no longer overwrite a tool call that landed
  while it was open.

What decision 4 asked for is therefore done; decisions 1–3 and 5 stand
unchanged, and path rename (decision 2) is still open.

## Addendum (2026-08-26): the dual-plane collapse — the tree is the address book again

The 2026-08-18 addendum's "the tree document is retired" is reversed, and
the reversal is the completion of the same convergence, not a return to the
split this ADR closed. What the workspace-document design showed is that
placement and content belong in ONE CRDT structure: a workspace is a single
Loro document (`workspace-tree:<workspaceId>`) whose tree nodes carry each
document's containers, so a move on one peer and an edit on another merge
with no coordinator.

As built:

- **The workspace tree is the address book.** Listing, path resolution,
  names, pins, kinds, timestamps and branch HEAD all read from the
  workspace record. The `documents` table survives only as a frozen legacy
  inbox: the boot fold absorbs rows the tree does not know (deleting
  pre-kind rows as this project's own data defect), and nothing else reads
  or writes it. `rebuild-from-scratch.test.ts` is the permanent acceptance:
  the entire document surface works, across a restart, with zero rows.
- **Identity is unchanged.** `(workspaceId, path)` stays the user-facing
  identity and the ULID `documentId` stays the stable one; a `DocRef`'s
  document arm now carries `workspaceId` explicitly because a bare id no
  longer names a storage location of its own.
- **Versions and branches are keyed on `workspaceId`** (migration `0015`),
  with `documentId` as a plain column: migration `0016` rebuilds both
  tables without migration `0001`'s FK to `documents`, because a
  tree-created document has no row for it to reference. Delete
  completeness moved from the cascade into the delete path's explicit
  cleanup.
- **Contested paths are surfaced, not auto-resolved.** Two replicas can
  merge into one path holding two documents; the listing marks the
  shadowed entries and resolution is an explicit rename — an ambiguous
  agent resolution is an error, never a silent suffix.

Decisions 1–3 and 5 still stand; decision 2's rename is now the tree
index's `moveDocument`, one operation with the collision rules in one
place.

## Addendum (2026-08-28): browser-to-daemon promotion — identity crosses the keeper boundary

The Context's original observation — "documents kept in the browser cross
into daemon mode only by an explicit, user-initiated copy, which re-creates
the document under a new path" — no longer holds, and the change is the
workspace-document design paying off once more rather than a new mechanism.

As built (whole-workspace move, Settings → Connections → "This workspace"):

- **The move is a CRDT merge of the whole workspace record.** The browser
  exports its `workspace-tree` record as one snapshot and POSTs it to the
  daemon's existing `workspace-document/update` route; nothing new was
  added server-side. Every ULID `documentId`, every display name, and the
  full edit history arrive intact, so references between documents keep
  resolving on the daemon.
- **Referenced images travel beside the record**, per file through the
  existing document-file route, with per-file outcomes (`missing` /
  `failed`) that never fail the merge that already landed. Re-running the
  move is an idempotent merge.
- **Collisions are surfaced, never auto-resolved** — the same shadowed
  rule as the dual-plane collapse above: a path both sides hold lists both
  documents, the pre-existing one marked shadowed.
- **Chunking was measured out, not built.** A 300-document record measured
  ≈0.88 MiB against the route's 16 MiB body cap, so whole-record import
  ships and a chunked transfer stays unbuilt until a real corpus needs it.
- **The browser does not become a replica.** After the move its record
  remains an independent store; continuing from the daemon is a narrated
  reload the user takes (backend mode is decided at page load, ADR-0004),
  and when the app later runs in browser mode with that daemon still
  configured, the connection popover discloses the move and that browser
  edits stay local. A dedicated demote action is deliberately absent: the
  browser record surviving by construction is the rollback.
- **The per-document copy import is deleted.** It preserved no identity —
  the daemon minted a new id per copy — and keeping it beside the move
  would have left users a worse path to the same outcome.

Decisions 1–3 and 5 still stand; this addendum updates only the Context's
account of how browser-kept documents reach a daemon.
