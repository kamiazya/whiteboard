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

## Common mistakes (append as review finds them)

- Importing a store/sync implementation directly instead of taking it via
  `ServerDeps`.
- Importing `node:*` or DOM globals in this shared-layer package.
- Adding a hand-written interface next to a Zod schema instead of `z.infer`.

## Tool surface criteria (ADR-0030)

A tool definition here is read by a model on every turn, so its cost and its
clarity are measured, not argued. Before changing a tool's name, description,
schema or existence, read `docs/contributing/adr/0030-tool-surface-criteria.md`
— the numbered criteria, and which instrument checks each — and expect
`packages/mcp-server/src/server/mcp/tool-surface-quality.test.ts` to fail
until its pinned row is updated with a line saying why it moved. A retirement
or a consolidation also runs the LLM-driven lane
(`pnpm --filter @kamiazya/whiteboard-mcp eval:tool-surface`) before and after.

Two of the criteria are debt this package owns today: every input parameter
carries a `.describe()` (299 do not), and a tool is registered with its Zod
OBJECT rather than its `.shape`, so `.strict()` reaches the boundary and a
typo'd key is refused rather than stripped (15 tools strip).
