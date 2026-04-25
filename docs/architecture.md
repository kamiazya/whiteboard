# Architecture

This project is split into three main runtime layers:

1. A `stdio` MCP server that tools like Claude Code and Codex connect to.
2. A local daemon that serves HTTP and WebSocket endpoints on loopback.
3. A browser canvas built with React, Excalidraw, and Loro-backed synchronization.

## Main components

- **stdio MCP server**
  - Entry point: `dist/server/mcp/index.js`
  - Registers tools, prompts, and resources
  - Talks to the daemon over local HTTP
- **daemon**
  - Entry point: `dist/server/index.js --daemon`
  - Serves `/api/*`, `/mcp`, static app assets, and WebSocket updates
  - Owns token-gated local HTTP transport and runtime lifecycle
- **browser canvas**
  - React + Excalidraw app under `dist/app`
  - Connects to the daemon over WebSocket
  - Applies remote updates and emits local edits
- **storage**
  - Lives under `~/.whiteboard/{workspaceId}/`
  - Stores canvas state, branches, checkpoints, exports, and library metadata

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

## Why Loro

Loro is the CRDT layer used to keep whiteboard state mergeable and replayable.

- It supports incremental updates for collaboration flows.
- It supports snapshot export for persistence and restore.
- It works well with versioning, branching, and checkpoint restore.

## Design boundaries

- The MCP layer owns tool contracts and host-facing integration.
- The daemon owns local HTTP transport, persistence, and browser coordination.
- The browser owns rendering, direct manipulation, and user-visible canvas state.

This separation keeps packaged `stdio` distribution simple while still allowing HTTP-first local development and future remote-ready MCP work.
