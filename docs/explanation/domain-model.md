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
  in is part of the address (`/w/<namespace>/<workspace>`), so a link, a
  bookmark and the back button all carry it.

  A workspace has three names, and only two are yours to choose. The one in
  the URL is short and URL-safe; the one in the header is free text with no
  restrictions; the third is an identifier the app keeps for itself and never
  shows you. Renaming changes what you chose and never the identity — which
  is why a link built on the identifier keeps working across a rename, and
  one built on the short name does not.

  The short name only has to be unique among the workspaces of one
  **namespace**
  ([ADR-0053](../contributing/adr/0053-workspace-segment-namespace.md)). A
  keeper with one person — the browser, a daemon on your own machine — has a
  single namespace, `me`. On a shared server every person has their own,
  named by a handle derived from their display name the first time they sign
  in, and a workspace belongs to the namespace of whoever created it. Two
  people can each have a `design` workspace there, and creating or renaming
  one never tells you whether somebody else uses that name. A short name you
  type means one of your own workspaces; one shared with you from somebody
  else's namespace is addressed by its identifier, or — in an agent's tool
  call — by `<handle>/<short name>`. A tool call never creates a workspace
  in somebody else's namespace.


  So the address the app shows is `/w/<namespace>/<short name>` on every
  keeper — `/w/me/design` in the browser and on your own daemon,
  `/w/ada/design` for Ada's workspace on a shared server. The other form is
  `/w/<identifier>`, which names the workspace and nothing else: it survives
  every rename, and it is what **Copy link** hands you on a shared server,
  because a link may reach somebody who is not a member and the readable form
  would tell them whose workspace it is and what it is called. A member who
  opens it is moved onto the readable address; anybody else gets the same
  refusal as for an address that names nothing. A one-part `/w/<short name>`
  from before namespaces no longer opens anything — only the identifier fits
  in that position now.
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
mode, it is the `<path>` in `/w/<namespace>/<workspace>/d/<path>`, and it is unique within
its workspace — the store refuses a second document at a path another one holds,
because a duplicate would make that address ambiguous rather than merely
untidy.

A path is not kept in step with a display name. It follows the name exactly
once: the first time you name a document from its title while its path is still
the generated one (`untitled`, `untitled-2`, …), the path becomes the name in
lower case with each run of other characters turned into one hyphen —
"Checkout Architecture" moves `untitled` to `checkout-architecture`, or
`checkout-architecture-2` when that path is taken in the same folder. The
address bar changes in place, with no reload and no extra Back step. After
that the path is fixed, and later renames change what the document is called,
never where it lives. A name the path alphabet cannot spell (a title written
entirely in Japanese, say) gives no path, so the document stays at its
generated one and the next name may still claim it; the same goes for a name
that would itself read as generated, like "Untitled 2". A path you chose, in
**Name and folder…** or by moving the document, is never replaced.
[ADR-0008](../contributing/adr/0008-slug-derivation-and-rename.md) records why
paths were not derived from names to begin with: every non-Latin title
collapsed to `untitled-N`.

The display name can come from the document instead. A note still at a
generated path (`untitled`, `untitled-2`, …) that nobody has named takes its
name from a level-1 heading on its first line, and keeps following that
heading while it is being typed. It stops for good once someone names the
note — when creating it, by renaming it, or through a `title` a document they
import carries (one equal to the name it already has says nothing new) — or gives it an address of their own in place of `untitled`. A
name you choose is kept even when the heading starts with it: "Weekly" stays
"Weekly" under a `# Weekly review` heading. Both keepers do this, and
neither touches the path: only naming the document from its title does.

A `[[reference]]` between documents is written as a **path** or a
**document id** — display names never resolve; they label a link at render
time instead. The id survives everything; a path reference is repointed
automatically when its target moves, which includes the move a first rename
makes, and a rename (of the display name) changes what links show, never what
they mean.

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
  share link, an embed) resolves to it again after a restore. A document's
  **saved versions stay with it in the trash**: they are keyed by that same
  `documentId`, so a restore brings its history back too. This holds whether
  the browser or the daemon keeps the workspace, and on the daemon whether
  the delete arrives as a request or inside a live-sync update of the
  workspace: the daemon puts every document such an update removes in the
  trash, with its content as it stood before the update and the documents
  below it carried along, before it keeps the update — and if that content
  cannot be stored, the update is refused and nothing of it is kept. The trash
  section appears only when it holds something. **Delete permanently** on a
  trash row is the one step with no way back: after a confirmation that names the
  document by the name it had (its path if it had none), it removes
  the row, the evacuated content and the document's saved versions, so the
  document can no longer be restored and the images only it used are no
  longer kept for it. It does not rewrite
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
  saved versions point at — the record keeps history back to the point every
  version descends from and nothing before that, counting the versions of a
  document in the trash until it is deleted permanently. That point is found
  in the history itself, never from a version's date, so a version carried
  in by a workspace move with an earlier date than its place in the history
  cannot cut the others away. Deleting old versions (or the automatic
  version pruning) is therefore what lets compaction reclaim space; the
  earliest point in the history a version stands at is the whole answer.
- Documents kept in the browser cross to a daemon by an explicit,
  user-initiated **move of the whole workspace** (Settings → Connections →
  "This workspace"): the browser's workspace record merges into the chosen
  daemon workspace, so every `documentId` and the full edit history carry
  over, with the trash (its documents' bytes, so they stay restorable), the
  saved versions, and every image any of them uses; a path both sides hold
  is surfaced as shadowed rather than renamed. Once the daemon reports
  holding all of it, the old browser record is deleted and the browser keeps a
  cached replica of the daemon workspace instead (editable when the daemon
  is unreachable, its edits sent on reconnect); continuing from the daemon is a reload the user takes.
  If anything could not be verified, the browser copy is kept unchanged and
  the result says so — the two copies do not sync on their own. There is no
  per-document copy: it would re-create each document under a new identity.

The identity decision itself — `(workspaceId, path)` as the canonical
user-facing identity — is still
[ADR-0007](../contributing/adr/0007-canvas-identity-and-store-split.md); its
as-built addendum records the convergence above.

← Back to [documentation home](../)
