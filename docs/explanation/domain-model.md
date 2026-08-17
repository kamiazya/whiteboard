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
- **Workspace** — a named collection of canvases. Only daemon mode has
  real, multiple workspaces; browser-local mode behaves as one fixed,
  implicit workspace (that constraint is modeled as "a single workspace
  that is always present", not as the absence of the concept).
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
  `tags`, and any root-level keys this app does not model. A spatial
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
| Browser-local | a random UUID, generated at creation | display name, plus a *display path* derived from the name |
| Daemon (gallery, editing, sync) | the pair `(workspaceId, path)` | display name, plus the path |
| Daemon (agent/MCP tree) | a ULID `documentId` plus a `segment` path | alias path derived from segments |

**Paths are the canonical user-facing identity** in daemon mode: URLs,
sync, versions, and branches all address a canvas as
`(workspaceId, path)`. A path is assigned at creation (derived
automatically — `untitled`, `untitled-2`, … — since creation asks for no
name up front) and is currently immutable; whether paths become renamable
is deliberately an open question (see
[ADR-0007](../contributing/adr/0007-canvas-identity-and-store-split.md),
which predates the rename and calls this a *slug* throughout).

Browser-local canvases have no persisted or canonical path. The
path-shaped label under a
card in the browser-local list is **cosmetic**: it is derived from the
display name on every render, is never stored, and collisions are
suffixed (`notes`, `notes-2`). It deliberately uses the same character
set as daemon paths so that, if browser-local canvases ever gain real
paths, the labels users already see can be promoted without changing.

## One product concept, one daemon-side store

The daemon once kept **two separate stores** that both held documents and
did not see each other: the workspace/path store behind the web app, and a
document store behind the agent-facing MCP tools. A document an agent
created was invisible in the gallery, and a document the web app created was
invisible to `wb_document_list`.

That split is **gone**, in three steps recorded in the migration log:

- Migration `0007` adopted every `workspace-tree:<workspaceId>` document into
  the shared `documents` table, retiring the separate tree document.
- Migration `0008` (and `0012` for the rows a later minting site kept
  producing) re-minted every id as a ULID, so both surfaces address a
  document by the same identifier — one table, one id space.
- The byte store converged last: `loadDocument`/`saveDocument` read and write
  the same Libsql snapshot rows the MCP tools use. Migration `0011` imported
  the pre-existing filesystem blobs, the daemon re-runs that import at every
  startup to catch anything written in between, and a blob file is deleted
  only once its bytes are proven byte-identical to the stored rows.

## Practical consequences today

- An agent and a human work on the same document through whichever surface
  they prefer: an MCP tool call, the daemon's HTTP API, and the WebSocket
  session all read and write one stored document.
- A save from a long-lived editing session **merges** the stored snapshot
  before writing, so a tool call that lands mid-session is not overwritten by
  the next save from that session.
- A document whose `kind` was never recorded reports **no** kind rather than
  claiming `spatial`; a surface that must render something (the gallery's
  kind badge, the editor choice) decides locally.
- Browser-local documents still cross into daemon mode only by an explicit,
  user-initiated copy, which re-creates the document under a new path — no
  identifier carries over. That half of ADR-0007 is unchanged.

The identity decision itself — `(workspaceId, path)` as the canonical
user-facing identity — is still
[ADR-0007](../contributing/adr/0007-canvas-identity-and-store-split.md); its
as-built addendum records the convergence above.

← Back to [documentation home](../)
