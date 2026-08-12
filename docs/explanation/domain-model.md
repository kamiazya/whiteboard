# Domain model

Understanding-oriented: what a canvas *is* in each of whiteboard's runtime
modes, how canvases are identified, and why the same product concept is
backed by more than one representation today. Read
[architecture](architecture.md) first for the runtime layers themselves.

## The nouns

- **Canvas** — one drawable document. It has a `kind`: `spatial` (the
  OpenCanvas node-and-edge editor) or `markdown` (a single markdown body).
  The kind is chosen at creation and does not change afterwards — except
  that restoring a version also restores that version's kind.
- **Workspace** — a named collection of canvases. Only daemon mode has
  real, multiple workspaces; browser-local mode behaves as one fixed,
  implicit workspace (that constraint is modeled as "a single workspace
  that is always present", not as the absence of the concept).
- **Display name** — the human title of a canvas. Optional; a canvas
  without one shows its identifier instead. Renaming changes only the
  display name, never the identity.

## Identity, per mode

| mode | identity of a canvas | shown to the user |
|---|---|---|
| Browser-local | a random UUID, generated at creation | display name, plus a *display slug* derived from the name |
| Daemon (gallery, editing, sync) | the pair `(workspaceId, slug)` | display name, plus the slug |
| Daemon (agent/MCP tree) | a ULID `canvasId` plus a `segment` path | alias path derived from segments |

**Slugs are the canonical user-facing identity** in daemon mode: URLs,
sync, versions, and branches all address a canvas as
`(workspaceId, slug)`. A slug is assigned at creation (derived
automatically — `untitled`, `untitled-2`, … — since creation asks for no
name up front) and is currently immutable; whether slugs become renamable
is deliberately an open question (see
[ADR-0007](../contributing/adr/0007-canvas-identity-and-store-split.md)).

Browser-local canvases have no persisted or canonical slug. The
slug-shaped label under a
card in the browser-local list is **cosmetic**: it is derived from the
display name on every render, is never stored, and collisions are
suffixed (`notes`, `notes-2`). It deliberately uses the same character
set as daemon slugs so that, if browser-local canvases ever gain real
slugs, the labels users already see can be promoted without changing.

## One product concept, two daemon-side representations

The daemon currently keeps **two separate stores** that both hold
"canvases", and they do not see each other:

- The **workspace/slug store** backs everything the web app shows and
  edits: the gallery, the editor, names, pins, kinds, branches, versions,
  and sync. Its writers are the daemon's HTTP API only.
- The **OpenCanvas doc store** backs the agent-facing MCP tools
  (`wb_canvas_*`, `wb_document_set`, node/edge patches, facets) and the
  `/api/v1` routes. It organizes canvases as a CRDT tree of
  ULID-identified documents with derived alias paths, and it is what the
  gallery's *tree view* renders.

A canvas created by an agent through MCP therefore does **not** appear in
the daemon gallery's grid, and a canvas created from the web UI does not
appear to `wb_document_list`. The only value the two representations share
is the raw `workspaceId` string, and neither side treats the other's use
of it as authoritative. This split is a known, recorded state — not an
accident and not yet a converged design — and the decision record for it,
including what is settled (slug-canonical identity, single-workspace
browser-local) and what is still open (slug rename, the convergence
path), is [ADR-0007](../contributing/adr/0007-canvas-identity-and-store-split.md).

## Practical consequences today

- Agents and humans collaborate on the same canvas only when they go
  through the same surface (for example, an agent driving the daemon's
  HTTP API, or a human using the tree view over `/api/v1` documents).
- The workspace selector in the daemon gallery lists workspaces from the
  workspace/slug store; the tree view reads the OpenCanvas store. A
  workspace that exists in only one of the two renders as missing or
  empty in the other.
- Browser-local canvases cross into daemon mode only by an explicit,
  user-initiated copy, which re-creates the canvas under a new slug —
  no identifier carries over.

← Back to [documentation home](../)
