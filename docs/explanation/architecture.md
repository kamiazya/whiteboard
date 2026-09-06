# Architecture

<p align="center">
  <img src="../assets/architecture.png" alt="Agent and user both draw on the same whiteboard via the Whiteboard MCP server" width="780" />
  <br />
  <sub><i>Source: <a href="../assets/architecture.canvas">architecture.canvas</a> — open as a JSON Canvas document to remix.</i></sub>
</p>

This project is split into three main runtime layers:

1. A `stdio` MCP server that tools like Claude Code and Codex connect to.
2. A local daemon that serves HTTP and WebSocket endpoints on loopback.
3. A browser canvas built with React, a spatial canvas editor, and Loro-backed synchronization.

## Main components

- **stdio MCP server**
  - Entry point: `dist/server/mcp/index.js`
  - Registers tools, prompts, and resources
  - Talks to the daemon over local HTTP
- **daemon**
  - Entry point: `dist/server/index.js --daemon`
  - Serves `/api/*`, `/mcp`, static app assets, and WebSocket updates
  - Owns token-gated local HTTP transport and runtime lifecycle
  - Serves the canonical `apps/web` build (`dist/web-app`, copied in by its
    postbuild step) as its own same-origin UI (see
    [ADR-0001](../contributing/adr/0001-apps-web-canonical-frontend.md));
    server-mode serves a minimal static placeholder at its root instead
- **browser canvas**
  - React app in `apps/web` rendering document content through the
    `SpatialEditor` component (select, move, resize, connect, and edit
    existing nodes), deployable standalone or served same-origin by the
    daemon
  - Connects to a daemon over WebSocket (same-origin when daemon-served, or
    paired via a `#wb=` bootstrap link when hosted separately)
  - Applies remote updates and emits local edits
- **storage**
  - Lives under `~/.whiteboard/{workspaceId}/`
  - Stores canvas state, branches, versions, exports, and library metadata

## Data flow

### MCP tool call path

1. Claude Code or Codex sends a tool call to the `stdio` MCP server.
2. The MCP server resolves the current workspace and calls daemon HTTP routes.
3. The daemon updates persistent state or forwards browser-dependent work.
4. The MCP server returns structured JSON back to the MCP client.

### Browser collaboration path

1. A browser opens `/w/{workspaceId}/document/{path}`.
2. The app loads the current canvas snapshot from the daemon.
3. Local edits update the in-memory document and are persisted through daemon routes.
4. WebSocket events broadcast document changes, version events, and branch head changes.

## MCP tool surface

The MCP server exposes a small, opinionated set of tools that match the canvas lifecycle.

| Tool | Purpose |
|---|---|
| `wb_document_create` / `wb_document_list` / `wb_document_resolve` / `wb_document_delete` | Document lifecycle (CRUD). |
| `wb_workspace_edit` | Apply an ordered list of document operations — `document.create`, `document.set`, `document.delete` — to a workspace in one call, so seeding or reorganising a workspace does not cost one round trip per document. Ids minted by a `document.create` come back in the result. Unlike `wb_canvas_edit` this does **not** roll back: each document is its own CRDT, so a failure reports the op index that failed and how many before it stand, and the caller resumes from that index rather than resending the batch. |
| `wb_body_edit` | Replace passages of a markdown document's BODY. Each op quotes the passage it means and declares what that passage said when the edit was written, so a passage an intervening edit moved is still found — the addressing a line number cannot give. Passages are stored as a PROPOSAL for a person to adopt or dismiss rather than changing the document ([ADR-0029](../contributing/adr/0029-proposal-layer.md)); that is the default, since nobody watches an agent type, and `mode: "apply"` changes the body directly. `proposalId` keeps several calls in one proposal. A passage that has CHANGED since the edit was written is refused by name when applying, and kept as a collision for the person to see when proposing — a proposal follows the document. A passage that resolves nowhere is refused in either mode, having no place to be drawn. Either every passage in a call is accepted or none is, and two passages that overlap are refused, since applying both would write text neither one proposed. |
| `wb_body_patch` | Update a text NODE's Markdown body on a spatial canvas. Updates only — a node that is not there is an error, not a create. It cannot reach a markdown document's body: that lives in a text container the canvas read does not see, so `wb_body_edit` is the tool for prose. |
| `wb_facet_set` | Set structured facet metadata on a document, or on one node of a spatial document. |
| `wb_facet_list` | List the facets this deployment registered — the exact key to write, which objects each may be attached to, and the payload schema. |
| `wb_scene_render` | Render a document to an SVG string from its persisted content — a canvas as its scene, a markdown document as a page — no browser connection required. `embedReferences` draws what the document links to (file nodes, `![[path]]` embeds and their `#Heading` / `#Group` parts); `fragment` renders one such part alone. The reported `width`/`height` cover everything drawn, edges included, not just the nodes' own boxes. |
| `wb_canvas_edit` | Apply a batch of edits to a spatial document in one transaction — add, patch, remove, lock and tidy nodes and edges; add or resolve comments (the annotation layer: a pinned remark anchored at a point or a node, drawn floating on every rendered surface — resolving is the only way to close one, for an agent and a person alike); plus `region.set` to reconcile a group's contents to a declared list (the one op that deletes by omission; scoped by strict containment, so a node straddling the group's edge is never touched). Either every op applies or none does, and a refusal names the op that failed by index. Node geometry is optional: a node with no `x`/`y`/`width`/`height` is placed below the existing content and the chosen position is reported back under `geometry`. The result also carries the resulting board, so a caller never needs a second read to see what it just wrote. A batch of CONTENT changes is stored as a PROPOSAL for a person to adopt or dismiss rather than changing the document ([ADR-0029](../contributing/adr/0029-proposal-layer.md)) — that is the default, since nobody watches an agent type; `mode: "apply"` changes the document directly, which is what a surface a person is looking at passes. A batch carrying anything a proposal cannot represent — comments, locks, `tidy`, `region.set` — applies whatever the mode, those being claims and layout rather than content. `proposalId` keeps several calls in one proposal. A proposal carries node and edge adds, patches and removes — a verb with no single anchor (`tidy`) or one that deletes by omission (`region.set`) is refused by name, since neither could be adopted in part. |
| `wb_viewport_set` | Move a watching browser's view of a spatial document — frame specific elements, or pan and zoom directly. Answers `delivered: false` rather than failing when no browser is open, so it is safe to call headlessly. `wb_canvas_edit` already follows its own edits; use this to point at something you did not just change. |
| `wb_canvas_snapshot` | The one read of a spatial document. By default, **what is on it**: every node with its type, text, stored geometry and lock state, plus every edge and every comment (the annotation layer, resolved records included), with long text and large boards cut and the true totals reported alongside so a capped read never looks complete. With `layout: true`, additionally **whether it is tidy**: overlap, containment, cluster and free-region analysis of the laid-out scene, named by the document's own node ids so anything it reports can be acted on with a `node.patch` op. The layout half also marks each node whose content does not fit its box as `overflows` — the one fact the stored geometry cannot show, since whether text fits is only knowable after it is measured. It is opt-in because it costs a full layout pass. This is the read to reach for before editing a canvas — `wb_document_get` answers with the whole untruncated JSON Canvas. |
| `wb_document_get` / `wb_document_set` | Read and replace a document's content. `wb_document_get` answers in the document's own format — OKF Markdown for a markdown document, JSON Canvas 1.0 (with the `x-whiteboard` extension) for a spatial one — and the format is not a parameter. `wb_document_set` writes OKF Markdown. |
| `wb_version_save` / `wb_version_restore` / `wb_version_list` | Save, list and restore versions in the document's history — the same history the History panel shows, so a checkpoint an agent takes is visible to the person watching, and a version a person saved can be rolled back to by an agent. `wb_version_save` answers the row as the panel lists it (`version.id` is what `wb_version_restore` takes); `wb_version_list` includes automatic checkpoints (`auto: true`). `wb_version_restore` reconciles the past state onto the document in place by default; `targetPath` restores it into another path instead (a new document, or an existing one with `overwrite: true`), and `subtree: true` rolls the document and every descendant back together. |

**A content write has to match the document's format.** The two formats share
one stored structure — a markdown document keeps its OKF body in a spatial
text node — so an unguarded cross-format write would not fail, it would
destroy: OKF into a diagram replaces its nodes and edges, a node into a
markdown document lands beside the one holding its body. The first content
write declares the document's format and every later write must match it, so
`wb_document_set` on a spatial document and `wb_canvas_edit` on a
markdown one are errors. A document created before formats were recorded takes
its format from the first write.

Every tool above operates on the persisted document and never requires a
connected browser tab — canvas rendering and export are headless. `wb_document_create`
is the only tool that lazily creates a canvas on first touch; the patch/render/export/
version tools all fail with an explicit error if `canvasId` does not resolve to an
existing canvas, instead of silently creating a new, empty one. The same discipline
applies one level up: an unknown `workspaceId` is an error, never an implicit new
workspace — bootstrapping a genuinely new workspace requires passing
`createWorkspace: true` to `wb_document_create`.

## Why Loro

Loro is the CRDT layer used to keep whiteboard state mergeable and replayable.

- It supports incremental updates for collaboration flows.
- It supports snapshot export for persistence and restore.
- It works well with versioning, branching, and version restore.

## Design boundaries

- The MCP layer owns tool contracts and host-facing integration.
- The daemon owns local HTTP transport, persistence, and browser coordination.
- The browser owns rendering, direct manipulation, and user-visible canvas state.

This separation keeps packaged `stdio` distribution simple while still allowing HTTP-first local development and future remote-ready MCP work.
