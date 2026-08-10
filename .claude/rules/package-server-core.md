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
- Tree ops, alias/index derivation — `canvas-workspace`.

## Dependency rules

- Runtime dependencies: `canvas-model`, `canvas-codec`, `canvas-render`,
  `canvas-ports`, `canvas-workspace`, `hono`, and `zod` (via `catalog:` or
  `workspace:*`).
- Forbidden imports: `node:*`, DOM globals (`document`/`window`/`navigator`),
  `inversify`.
- Enforced by `tools/arch-lint` (`arch-lint-node` vitest project) and the
  dependency-direction check against `architecture-map.ts`.

## Conventions

- Tools and routes receive their dependencies from the `createServer`
  factory (via `ServerDeps`), never through direct module imports of a
  store/sync implementation. The shared layer only knows the port
  contracts from `canvas-ports`.
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
