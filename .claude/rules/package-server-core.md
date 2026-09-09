---
paths:
  - "packages/server-core/**"
---

# server-core — /api/v1 Hono routes + MCP tool definitions, createServer(deps) factory

## What belongs here

- The `createServer(deps)` factory: assembles a `Hono` app from the
  store/sync ports supplied via `ServerDeps`, and returns `{ app }`.
- `/api/v1` Hono route definitions (future slices).
- MCP tool definitions and MCP resource definitions (future slices) —
  their `inputSchema`/`outputSchema` and `execute` handlers, wired to the
  injected deps.
- Response-schema declarations shared with typed clients (declared once as
  Zod, imported via `z.infer` on both sides).

## What does NOT belong here

- Store/sync **implementations** (local libSQL/fs, IndexedDB, Durable
  Objects/D1/R2) — those live in composition roots (`mcp-server`,
  `apps/web`, future Cloudflare root). This package receives them through
  the factory as `ServerDeps`.
- CLI, stdio transport, daemon startup/registry logic, resvg, or any
  process lifecycle — `mcp-server` owns that.
- InversifyJS or any DI container wiring — composition roots only.
- Scene graph, layout, rendering internals — `canvas-render`.
- Tree ops, alias/index derivation — `loro-adapter`.

## Dependency rules

- Runtime dependencies: `model`, `codec`, `canvas-render`,
  `ports`, `facet-engine`, `loro-adapter`, `hono`, and `zod` (via `catalog:`
  or `workspace:*`).
- Forbidden imports: `node:*`, DOM globals (`document`/`window`/`navigator`),
  `inversify`.
- Enforced by `tools/arch-lint` (`arch-lint-node` vitest project) and the
  dependency-direction check against `architecture-map.ts`.

## Conventions

- Tools and routes receive their dependencies from the `createServer`
  factory (via `ServerDeps`), never through direct module imports of a
  store/sync implementation. The shared layer only knows the port
  contracts from `ports`.
- Every contract crossing a process boundary (MCP tool I/O, HTTP response
  shape) is declared once as a Zod schema and consumed via `z.infer` — no
  hand-written interface next to a schema.

## Tests

- Vitest project: `server-core-node` (registered in root `vitest.config.ts`).
- Smoke: `createServer` returns an app whose `fetch` is callable.

## Render style and canvas-target facets (ADR-0030)

- `wb_scene_render` and the daemon's export routes take `style`, parsed by
  `spatialRenderStyleSchema` from `canvas-render` — `'clean'`, `'document'`,
  or a registered theme id. The tool DEFAULTS it to `'clean'` in the schema
  (so `z.infer` makes it required on `execute`, and a test calling the tool
  directly passes it), the export contracts leave it optional and the layout
  supplies the same default. Absent never means "the document's theme": an
  agent reading SVG pays for a theme's jitter or glow only when it asks.
- `composeCanvasScene` forwards `style` and nothing else theme-shaped. The
  digest goes through the same composer with no style, which is what keeps
  `wb_canvas_snapshot`'s layout analysis from moving because a theme did.
- `wb_facet_set`'s `target: 'canvas'` writes `x-whiteboard.facets` on a
  spatial document with the web editor's canonical emptiness (an empty
  bucket disappears, and an empty envelope with it). It is an enum of two,
  not three: `nodeId` already says "a node", and `nodeId` beside
  `target: 'canvas'` is refused at execute time
  (`NodeAndCanvasTargetError`) rather than by a schema `.refine`, because a
  refined schema loses the `.shape` MCP registration reads.
- A theme id in a clean render is asserted by the glow's filter id
  (`wb-glow`), never by the word `filter`: a drop shadow is a filter too,
  and the e2e smoke failed on exactly that substring once.

## Common mistakes (append as review finds them)

- Importing a store/sync implementation directly instead of taking it via
  `ServerDeps`.
- Importing `node:*` or DOM globals in this shared-layer package.
- Adding a hand-written interface next to a Zod schema instead of `z.infer`.
