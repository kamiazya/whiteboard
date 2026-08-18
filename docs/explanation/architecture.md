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
| `wb_body_patch` | Update a node's Markdown body. Updates only — a node that is not there is an error, not a create. |
| `wb_facet_set` | Set structured facet metadata on a canvas (used for the private ticketing backlog, among other uses). |
| `wb_scene_render` | Render the current canvas to an SVG string from its persisted document — no browser connection required. The reported `width`/`height` cover everything drawn, edges included, not just the nodes' own boxes. |
| `wb_canvas_edit` | Apply a batch of edits to a spatial document in one transaction — add, patch, remove, lock and tidy nodes and edges. Either every op applies or none does, and a refusal names the op that failed by index. Node geometry is optional: a node with no `x`/`y`/`width`/`height` is placed below the existing content and the chosen position is reported back under `geometry`. The result also carries the resulting board, so a caller never needs a second read to see what it just wrote. |
| `wb_canvas_snapshot` | Read a spatial document as a compact snapshot: every node with its type, text, geometry and lock state, plus every edge. Long text and large boards are cut, and the board's true node/edge totals are reported alongside so a capped read never looks complete. This is the read to reach for before editing a canvas — `wb_document_get` answers with the whole untruncated JSON Canvas, and `wb_scene_digest` carries no text at all. |
| `wb_scene_digest` | Return the AI-facing spatial digest (overlap/containment/cluster/free-region summary) of a canvas — whether the board is tidy, not what is on it. Entries are named by the canvas's own node ids, so anything the digest reports can be acted on directly with a `node.patch` op; content laid out inside a node is not reported as a node of its own. |
| `wb_document_get` / `wb_document_set` | Read and replace a document's content. `wb_document_get` answers in the document's own format — OKF Markdown for a markdown document, JSON Canvas 1.0 (with the `x-whiteboard` extension) for a spatial one — and the format is not a parameter. `wb_document_set` writes OKF Markdown. |
| `wb_version_save` / `wb_version_restore` / `wb_version_list` | Save and restore labeled canvas versions. `wb_version_restore` accepts an optional `targetPath` to fork the past state into a new canvas instead of reconciling in place. |

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
