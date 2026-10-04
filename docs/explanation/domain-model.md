# Domain model

Understanding-oriented: what a document *is* in each of whiteboard's runtime
modes, how documents are identified, and how a workspace keeps them. Read
[architecture](architecture.md) first for the runtime layers themselves.

## The nouns

- **Document** — the unit a workspace contains. It has a `kind`: `spatial`
  (a **canvas**, edited as nodes and edges) or `markdown` (a single markdown
  body).
  The kind is chosen at creation and does not change afterwards — except
  that restoring a version also restores that version's kind.
- **Workspace** — a named collection of documents. Both keepers hold as many
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
- **Display name** — the human title of a document. Optional; a document
  without one shows its identifier instead. Renaming changes only the
  display name, never the identity.

  The display name is the **only** place a document is named. Exporting a
  markdown document to OKF writes it as the frontmatter `title`, and
  importing OKF applies an incoming `title` back to the display name —
  both directions are projections of the one value, not a second copy.
  An OKF file with no `title` says nothing about the name, so importing
  it leaves the existing name alone.
- **Facets** — a markdown document's OKF frontmatter: its `type`, its
  `description` (shown as Summary), its `resource` (shown as Describes),
  its `tags`, and any root-level keys this app does not model, which are
  preserved untouched rather than dropped. A spatial
  document has none. JSON Canvas is nodes and edges with no frontmatter
  concept, so there is nowhere in that format for a facet to live — which
  is why the editor offers the Properties disclosure on a markdown document
  only, and why `wb_facet_set` refuses a facet on a spatial one without a
  target. A board's TAGS are another matter: a spatial document, each of
  its nodes and each of its edges carries tags of its own — plain ones and
  `key:value` scoped ones — written by the same tool
  ([ADR-0040](../contributing/adr/0040-scoped-tags.md)). Other metadata on
  a diagram is not built: it would be a workspace-level capability, not a
  facet ([ADR-0009](../contributing/adr/0009-mcp-tool-naming.md)).

## Identity, per mode

| mode | identity of a document | shown to the user |
|---|---|---|
| Browser | a ULID `documentId` plus the pair `(workspaceId, path)` | display name, plus the path |
| Daemon (every surface) | a ULID `documentId` plus the pair `(workspaceId, path)` | display name, plus the path |

The two daemon rows this table used to carry (the web gallery's
path-keyed identity and the MCP tree's segment-derived alias) are one row
now: every surface resolves the same workspace tree, where a document's
path is derived from its node's ancestry and its `documentId` is the node's
stable name.

**Paths are the canonical user-facing identity** in daemon mode: URLs,
versions and per-document text events all address a document as
`(workspaceId, path)`, while binary sync rides the workspace record and
scopes to a document by its `documentId`. A path is assigned at creation
(derived automatically — `untitled`, `untitled-2`, … — since creation asks
for no name up front) and can be renamed later; a stored `[[reference]]`
survives the rename because it names the `documentId` (see
[ADR-0007](../contributing/adr/0007-canvas-identity-and-store-split.md),
which predates the rename and calls this a *slug* throughout).

Documents kept in the browser are addressed the same way — literally the same
way, since both keepers use one URL grammar. A path is stored, not derived: it
is assigned at creation (`untitled`, `untitled-2`, …) exactly as in daemon
mode, it is the `<path>` in `/w/<workspace>/d/<path>`, and it is unique within
its workspace — the store refuses a second document at a path another one holds,
because a duplicate would make that address ambiguous rather than merely
untidy.

A path is never derived from a display name, in either mode.
[ADR-0008](../contributing/adr/0008-slug-derivation-and-rename.md) measured
that and found every non-Latin title collapsing to `untitled-N`, which is
indistinguishable in the very column a path exists to distinguish.

A `[[reference]]` between documents is written as a **path** or a
**document id** — display names never resolve; they label a link at render
time instead. The id survives everything; a path reference is repointed
automatically when its target moves, and a rename (of the display name)
changes what links show, never what they mean.

## One store behind every surface

A daemon workspace has one store: the **workspace record**, a single Loro
document that holds the tree (placement, names, pins and kinds) and every
document's content. The web app, the agent-facing MCP tools and the daemon's
HTTP API all resolve documents through it, so a document an agent creates is
the one the gallery lists, and a document the web app creates is the one
`wb_document_list` returns. Versions are keyed on the workspace, and a
document is addressed by the same `documentId` on every surface.

How the store came to be one — the earlier split between a path store and a
document store, and the migrations that closed it — is the as-built
addenda of
[ADR-0007](../contributing/adr/0007-canvas-identity-and-store-split.md).

## Practical consequences today

- An agent and a human work on the same document through whichever surface
  they prefer: an MCP tool call, the daemon's HTTP API, and the live-sync
  stream all read and write one stored document.
- A workspace's documents live in **one workspace record** (a single Loro
  document holding the tree and every document's content), and live sync
  runs at that granularity: a sync stream (SSE) receives the
  workspace record's snapshot and its updates, scoped in the client to the
  open document by its `documentId`. Text events (version created, restore,
  viewport) stay addressed per path.
- A save from a long-lived editing session **merges** into that record
  before writing, so a tool call that lands mid-session is not overwritten
  by the next save from that session.
- Every listed document carries its `documentId` and its `kind` — both are required
  by the listing contract, so a surface never has to render a document of
  unknown kind.
- A delete **evacuates before it removes**: the document's subtree is
  exported into content-addressed blob storage and recorded in the
  workspace's trash, so the file browser can list what went and restore it
  under the **same `documentId`** — anything that named the document (a
  share link, an embed) resolves to it again after a restore. The trash
  section appears only when it holds something. **Delete permanently** on a
  trash row is the one step with no way back: after a confirmation it removes
  the row and the evacuated content, so the document can no longer be restored
  and the images only it used are no longer kept for it. It does not rewrite
  the workspace's change history — edits recorded there before the delete stay
  in it until that history is compacted. There is no automatic expiry: the
  trash keeps what it holds until someone restores or deletes it.
- Because placement is CRDT state, two replicas can merge into **one path
  holding two documents**. Nothing is auto-renamed: the earlier document
  keeps the path, later ones are listed as *shadowed* (the gallery badges
  them), and resolution is an explicit rename — the file browser's Rename,
  or a `wb_workspace_edit` `document.move` op. An agent asking for a
  contested path gets an error pointing at resolution by `documentId` or a
  rename, never a silent suffix.
- The workspace record accumulates every edit's history, and the daemon
  periodically **compacts** it: history older than anything still reachable
  is folded into the snapshot. What stays reachable is exactly what your
  saved versions point at — the record keeps history back to the oldest
  version and nothing before that. Deleting old versions (or the automatic
  version pruning) is therefore what lets compaction reclaim space; the
  oldest version is the whole answer.
- Documents kept in the browser cross to a daemon by an explicit,
  user-initiated **move of the whole workspace** (Settings → Connections →
  "This workspace"): the browser's workspace record merges into the chosen
  daemon workspace, so every `documentId`, the full edit history, and
  referenced images carry over, and a path both sides hold is surfaced as
  shadowed rather than renamed. Once every document and image is verified
  on the daemon, the old browser record is deleted and the browser keeps a
  cached replica of the daemon workspace instead (read-only when the daemon
  is unreachable); continuing from the daemon is a reload the user takes.
  If anything could not be verified, the browser copy is kept unchanged and
  the result says so — the two copies do not sync on their own. There is no
  per-document copy: it would re-create each document under a new identity.

The identity decision itself — `(workspaceId, path)` as the canonical
user-facing identity — is still
[ADR-0007](../contributing/adr/0007-canvas-identity-and-store-split.md); its
as-built addendum records the convergence above.

← Back to [documentation home](../)
