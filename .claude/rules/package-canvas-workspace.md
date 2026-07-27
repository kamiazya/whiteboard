# canvas-workspace — tree ops, alias derivation, index derivation, LoroDoc bridge

## What belongs here

- Workspace tree operations via Loro's movable tree (`LoroTree`): create,
  move, rename, delete nodes. Node data `{ canvasId, segment }`.
- Alias derivation: root-to-leaf segment concatenation produces the alias
  path (`/w/{ws}/c/{aliasPath}`).
- Same-name segment resolution within a parent (sibling uniqueness
  invariant enforced at mutation time).
- Link extraction from Markdown bodies via canvas-codec's
  `resolveReferences` — produces backlink rows for WorkspaceIndex.
- WorkspaceIndex row derivation: facet index, canvas list, alias
  resolution, backlink, alias history — pure functions that turn tree +
  canvas docs into index rows matching the port DTOs.
- LoroDoc⇔model bridge: the CRDT merge–aware conversion deferred from
  canvas-codec.

## What does NOT belong here

- Store/sync **implementations** (local libSQL/fs, IndexedDB, Durable
  Objects) — those live in composition roots (`mcp-server`, `apps/web`).
- HTTP routes, MCP tool definitions — those live in `server-core` or
  `mcp-server`.
- Scene graph, layout, rendering — `canvas-render`.
- InversifyJS or any DI container wiring — composition roots only.

## Dependency rules

- Runtime dependencies: `canvas-model`, `canvas-codec`, `canvas-ports`,
  `loro-crdt`, and `zod` (all via `catalog:` or `workspace:*`).
- Forbidden imports: `node:*`, DOM globals (`document`/`window`/`navigator`),
  `inversify`.
- Enforced by `tools/arch-lint` (`arch-lint-node` vitest project).

## Conventions

- `WorkspaceTree` wraps a `LoroDoc` and exposes tree mutations that
  enforce the sibling-uniqueness invariant — callers never manipulate
  `LoroTree` directly.
- Alias is always **derived**, never stored. The canonical path is the
  concatenation of segments from root to the target node.
- Every mutation calls `doc.commit()` after writing, so incremental
  exports (`mode: 'update'`) capture the change boundary.
- Segment validation matches the slug pattern
  `/^[a-zA-Z0-9]([a-zA-Z0-9_-]*[a-zA-Z0-9])?$/` — single characters
  are valid, leading/trailing hyphens are not.
- LoroDoc spatial layout: `doc.getMap('nodes')` keyed by nodeId,
  `doc.getMap('edges')` keyed by edgeId. Each value is a plain object
  (not a nested LoroMap container) — this preserves node-level CRDT
  merge while avoiding Loro's nested-container overwrite issues.

## Tests

- Vitest project: `canvas-workspace-node` (registered in root
  `vitest.config.ts`).
- Unit tests for tree operations, alias derivation, segment validation,
  sibling conflict detection, and CRDT merge behavior.
- `createAliasResolver` integration tests: confirms the bridge works
  end-to-end with `resolveReferences` from canvas-codec (wikiLink + embed).
- `extractBacklinks` tests: walks all mdast node types (paragraph, heading,
  blockquote, list, table, nested phrasing) with dedup assertion.
- `readSpatialCanvas`/`writeSpatialCanvas` tests: round-trip all node types
  (text/file/link/group), edges, x-whiteboard extensions, overwrite/delete
  semantics, and CRDT merge of independent node additions.

## Common mistakes (append as review finds them)

- Storing the alias as data instead of deriving it from segments.
- Allowing duplicate segments under the same parent.
- Importing `node:*` or DOM globals in a shared-layer package.
