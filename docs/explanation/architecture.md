# Architecture

<p align="center">
  <img src="../assets/architecture.png" alt="Agent and user both draw on the same OpenCanvas whiteboard via the Whiteboard MCP server" width="780" />
  <br />
  <sub><i>Source: <a href="../assets/architecture.canvas">architecture.canvas</a> — open as a JSON Canvas document to remix.</i></sub>
</p>

This project is split into three main runtime layers:

1. A `stdio` MCP server that tools like Claude Code and Codex connect to.
2. A local daemon that serves HTTP and WebSocket endpoints on loopback.
3. A browser canvas built with React, a spatial OpenCanvas editor, and Loro-backed synchronization.

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
  - React app in `apps/web` rendering OpenCanvas content through the
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

1. A browser opens `/canvas/{workspaceId}/{slug}`.
2. The app loads the current canvas snapshot from the daemon.
3. Local edits update the in-memory document and are persisted through daemon routes.
4. WebSocket events broadcast document changes, version events, and branch head changes.

## MCP tool surface

The MCP server exposes a small, opinionated set of tools that match the canvas lifecycle.

| Tool | Purpose |
|---|---|
| `wb_canvas_create` / `wb_canvas_list` / `wb_canvas_get` / `wb_canvas_delete` | Canvas lifecycle (CRUD). |
| `node_patch` / `edge_patch` / `body_patch` | Patch a canvas's spatial nodes, edges, or a node's Markdown body. |
| `facet_set` | Set structured facet metadata on a canvas (used for the private ticketing backlog, among other uses). |
| `canvas_render_svg` | Render the current canvas to an SVG string from its persisted document — no browser connection required. |
| `canvas_digest` | Return the AI-facing spatial digest (overlap/containment/cluster/free-region summary) of a canvas. |
| `canvas_export_okf` / `canvas_import_okf` | Export/import a canvas as an OKF Markdown document (YAML frontmatter + Markdown body). |
| `canvas_export_json_canvas` | Export a canvas as JSON Canvas 1.0 (with the `x-whiteboard` extension). |
| `version_save` / `version_restore` / `version_list` | Save and restore labeled canvas versions. `version_restore` accepts an optional `targetSlug` to fork the past state into a new canvas instead of reconciling in place. |

Every tool above operates on the persisted document and never requires a
connected browser tab — canvas rendering and export are headless. `wb_canvas_create`
is the only tool that lazily creates a canvas on first touch; the patch/render/export/
version tools all fail with an explicit error if `canvasId` does not resolve to an
existing canvas, instead of silently creating a new, empty one. The same discipline
applies one level up: an unknown `workspaceId` is an error, never an implicit new
workspace — bootstrapping a genuinely new workspace requires passing
`createWorkspace: true` to `wb_canvas_create`.

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
