---
paths:
  - "packages/canvas-workspace/**"
---

# canvas-workspace — LoroDoc<->model bridge

## What belongs here

- LoroDoc⇔model bridge: the CRDT merge–aware conversion deferred from
  canvas-codec. Reading and writing a document's content — spatial canvas,
  document kind, core facets, body.

## What does NOT belong here

- Placement: which documents a workspace holds, their paths, and their
  names. That is `canvas-ports`' `DocumentIndex`, implemented by each
  composition root. This package knows a document's content and nothing
  about where it sits.
- Store/sync **implementations** (local libSQL/fs, IndexedDB, Durable
  Objects) — those live in composition roots (`mcp-server`, `apps/web`).
- HTTP routes, MCP tool definitions — those live in `server-core` or
  `mcp-server`.
- Scene graph, layout, rendering — `canvas-render`.
- InversifyJS or any DI container wiring — composition roots only.

## Dependency rules

- Runtime dependencies: `canvas-model`, `canvas-ports`,
  `loro-crdt`, and `zod` (all via `catalog:` or `workspace:*`).
- Forbidden imports: `node:*`, DOM globals (`document`/`window`/`navigator`),
  `inversify`.
- Enforced by `tools/arch-lint` (`arch-lint-node` vitest project).

## Conventions

- Every mutation calls `doc.commit()` after writing, so incremental
  exports (`mode: 'update'`) capture the change boundary.
- LoroDoc spatial layout: `doc.getMap('nodes')` keyed by nodeId,
  `doc.getMap('edges')` keyed by edgeId. Each value is a plain object
  (not a nested LoroMap container) — this preserves node-level CRDT
  merge while avoiding Loro's nested-container overwrite issues.
- A third map, `doc.getMap('canvas')`, holds the canvas ENVELOPE —
  properties of the canvas rather than of anything on it (today
  `x-whiteboard`, the rendering preferences). Separate because the merge
  story differs in kind: nodes and edges are keyed per object so two peers
  editing different objects both survive, whereas a canvas-wide preference
  is one value with one meaning and last-writer-wins per key is all it
  needs. Anything the canvas carries beside `nodes`/`edges` must be written
  here — a schema round-trip through JSON is NOT evidence it persists,
  since this bridge is the path the app actually saves through.

## Tests

- Vitest project: `canvas-workspace-node` (registered in root
  `vitest.config.ts`).
- Unit tests for CRDT merge behavior across the bridge.
- `readSpatialCanvas`/`writeSpatialCanvas` tests: round-trip all node types
  (text/file/link/group), edges, x-whiteboard extensions, overwrite/delete
  semantics, and CRDT merge of independent node additions.

## Common mistakes (append as review finds them)

- Importing `node:*` or DOM globals in a shared-layer package.
