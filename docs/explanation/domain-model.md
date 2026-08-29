# Domain model

Understanding-oriented: what a canvas *is* in each of whiteboard's runtime
modes, how canvases are identified, and why the same product concept is
backed by more than one representation today. Read
[architecture](architecture.md) first for the runtime layers themselves.

## The nouns

- **Canvas** — one drawable document. It has a `kind`: `spatial` (the
  spatial node-and-edge editor) or `markdown` (a single markdown body).
  The kind is chosen at creation and does not change afterwards — except
  that restoring a version also restores that version's kind.
- **Workspace** — a named collection of canvases. Both keepers hold as many
  as you make: the app names the current one in the header, and the same
  control switches between them and creates new ones. Which workspace you are
  in is part of the address (`/w/<workspace>`), so a link, a bookmark and the
  back button all carry it.

  A workspace has three names, and only two are yours to choose. The one in
  the URL is short and URL-safe; the one in the header is free text with no
  restrictions; the third is an identifier the app keeps for itself and never
  shows you. Renaming changes what you chose and never the identity — which
  is why a link built on the identifier keeps working across a rename, and
  one built on the short name does not.
- **Display name** — the human title of a canvas. Optional; a canvas
  without one shows its identifier instead. Renaming changes only the
  display name, never the identity.

  The display name is the **only** place a canvas is named. Exporting a
  markdown canvas to OKF writes it as the frontmatter `title`, and
  importing OKF applies an incoming `title` back to the display name —
  both directions are projections of the one value, not a second copy.
  An OKF file with no `title` says nothing about the name, so importing
  it leaves the existing name alone.
- **Facets** — a markdown canvas's OKF frontmatter: its `type`, its
  `description` (shown as Summary), its `resource` (shown as Describes),
  its `tags`, and any root-level keys this app does not model, which are
  preserved untouched rather than dropped. A spatial
  canvas has none. JSON Canvas is nodes and edges with no frontmatter
  concept, so there is nowhere in that format for a facet to live — which
  is why the editor offers the Properties disclosure on a markdown canvas
  only, and why `wb_facet_set` refuses a spatial one. Metadata on a
  diagram is a reasonable thing to want and is not built: it would be a
  workspace-level capability, not a facet
  ([ADR-0009](../contributing/adr/0009-mcp-tool-naming.md)).

## Identity, per mode

| mode | identity of a canvas | shown to the user |
|---|---|---|
| Browser | a ULID `documentId` plus the pair `(workspaceId, path)` | display name, plus the path |
| Daemon (every surface) | a ULID `documentId` plus the pair `(workspaceId, path)` | display name, plus the path |

The two daemon rows this table used to carry (the web gallery's
path-keyed identity and the MCP tree's segment-derived alias) are one row
now: every surface resolves the same workspace tree, where a document's
path is derived from its node's ancestry and its `documentId` is the node's
stable name.

**Paths are the canonical user-facing identity** in daemon mode: URLs,
versions, branches, and per-document text events all address a canvas as
`(workspaceId, path)`, while binary sync rides the workspace record and
scopes to a document by its `documentId`. A path is assigned at creation
(derived automatically — `untitled`, `untitled-2`, … — since creation asks
for no name up front) and can be renamed later; a stored `[[reference]]`
survives the rename because it names the `documentId` (see
[ADR-0007](../contributing/adr/0007-canvas-identity-and-store-split.md),
which predates the rename and calls this a *slug* throughout).

Canvases kept in the browser are addressed the same way — literally the same
way, since both keepers use one URL grammar. A path is stored, not derived: it
is assigned at creation (`untitled`, `untitled-2`, …) exactly as in daemon
mode, it is the `<path>` in `/w/<workspace>/d/<path>`, and it is unique within
its workspace — the store refuses a second canvas at a path another one holds,
because a duplicate would make that address ambiguous rather than merely
untidy.

A path is never derived from a display name, in either mode.
[ADR-0008](../contributing/adr/0008-slug-derivation-and-rename.md) measured
that and found every non-Latin title collapsing to `untitled-N`, which is
indistinguishable in the very column a path exists to distinguish.

The identifier stays the durable one: a `[[reference]]` between canvases
names the target's `documentId`, so it survives both a rename and a move,
and following one resolves that identifier to the target's current path.

## One product concept, one daemon-side store

The daemon once kept **two separate stores** that both held documents and
did not see each other: the workspace/path store behind the web app, and a
document store behind the agent-facing MCP tools. A document an agent
created was invisible in the gallery, and a document the web app created was
invisible to `wb_document_list`.

That split is **gone**, in four steps recorded in the migration log:

- Migration `0007` adopted every `workspace-tree:<workspaceId>` document into
  the shared `documents` table, retiring the separate tree document.
- Migration `0008` (and `0012` for the rows a later minting site kept
  producing) re-minted every id as a ULID, so both surfaces address a
  document by the same identifier — one table, one id space.
- The byte store converged next: `loadDocument`/`saveDocument` read and write
  the same Libsql snapshot rows the MCP tools use. Migration `0011` imported
  the pre-existing filesystem blobs once, and a blob file was deleted only
  once its bytes were proven byte-identical to the stored rows.
- Finally the **workspace record became the address book itself**: placement,
  names, pins, kinds and branch HEAD live on the workspace tree's nodes as
  shared CRDT state, versions and branches are keyed on the workspace
  (migrations `0015`/`0016`), and migration `0017` dropped the `documents`
  table outright (approved plain break, pre-1.0 disposable-DB policy) — the
  workspace record is the store, full stop.

## Practical consequences today

- An agent and a human work on the same document through whichever surface
  they prefer: an MCP tool call, the daemon's HTTP API, and the WebSocket
  session all read and write one stored document.
- A workspace's documents live in **one workspace record** (a single Loro
  document holding the tree and every document's content), and live sync
  runs at that granularity: a WebSocket or SSE session receives the
  workspace record's snapshot and its updates, scoped in the client to the
  open document by its `documentId`. Text events (version created, restore,
  viewport) stay addressed per path.
- A save from a long-lived editing session **merges** into that record
  before writing, so a tool call that lands mid-session is not overwritten
  by the next save from that session.
- Every listed document carries its `id` and its `kind` — both are required
  by the listing contract. Rows recorded before kinds existed were this
  project's own pre-release data and are deleted at startup, so "kind never
  recorded" is no longer a state a surface has to render.
- A delete **evacuates before it removes**: the document's subtree is
  exported into content-addressed blob storage and recorded in the
  workspace's trash, so the file browser can list what went and restore it
  under the **same `documentId`** — anything that named the document (a
  share link, an embed) resolves to it again after a restore. The trash
  section appears only when it holds something.
- Because placement is CRDT state, two replicas can merge into **one path
  holding two documents**. Nothing is auto-renamed: the earlier document
  keeps the path, later ones are listed as *shadowed* (the gallery badges
  them), and resolution is an explicit rename. An agent asking for a
  contested path gets an error pointing at resolution by `documentId` or a
  rename, never a silent suffix.
- The workspace record accumulates every edit's history, and the daemon
  periodically **compacts** it: history older than anything still reachable
  is folded into the snapshot. What stays reachable is exactly what your
  saved versions and branches point at — the record keeps history back to
  the oldest version and the oldest branch tip, and nothing before that.
  Deleting old versions (or the automatic version pruning) is therefore
  what lets compaction reclaim space; a branch left on an old state keeps
  the history its checkout needs for as long as the branch exists.
- Documents kept in the browser cross to a daemon by an explicit,
  user-initiated **move of the whole workspace** (Settings → Connections →
  "This workspace"): the browser's workspace record merges into the chosen
  daemon workspace, so every `documentId`, the full edit history, and
  referenced images carry over, and a path both sides hold is surfaced as
  shadowed rather than renamed. The browser's own copy remains — the two
  copies do not sync on their own, and continuing from the daemon is a
  reload the user takes. The old per-document copy (which re-created
  documents under new identities) is deleted.

The identity decision itself — `(workspaceId, path)` as the canonical
user-facing identity — is still
[ADR-0007](../contributing/adr/0007-canvas-identity-and-store-split.md); its
as-built addendum records the convergence above.

← Back to [documentation home](../)
