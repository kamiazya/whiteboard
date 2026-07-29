# Architecture Map (OpenCanvas)

Package boundaries are cut by **runtime requirements**, not by feature. The shared layer must run unchanged on Node, the browser, and Cloudflare Workers.

| Package | Role | May depend on |
|---|---|---|
| `packages/canvas-model` | Zod schemas for the OpenCanvas data model (single source of truth) | zod only |
| `packages/canvas-codec` | OKF Markdown / JSON Canvas serialize+parse, remark pipeline | model, remark |
| `packages/canvas-render` | scene graph, layout, SVG backend, sceneDigest | model, zod |
| `packages/canvas-ports` | store/sync port contracts + Symbol `TOKENS` | model |
| `packages/canvas-workspace` | tree ops, alias derivation, index derivation, link extraction | model, codec, ports |
| `packages/server-core` | `/api/v1` Hono routes + MCP tool definitions, exposed as `createServer(deps)` | workspace, render |
| `packages/mcp-server` | Node composition root: CLI, stdio, local store impls, resvg, Inversify container | server-core + port impls |
| `apps/web` | Browser composition root: Canvas API backend, IndexedDB store impls | workspace, render + port impls |

Absolute rules:

1. Shared-layer packages (model / codec / render / ports / workspace / server-core) must not import `node:*`, DOM globals, or `inversify`.
2. Dependencies flow only in the table's direction. Composition roots are never imported by shared packages.
3. Unsure where code goes → load the `package-placement` skill (planned). DI wiring → `di-container` skill (planned).

These rules are enforced by `tools/arch-lint` (vitest project `arch-lint-node`): a TypeScript-compiler-API scan for banned imports/globals, a package.json dependency-direction check, and a per-package allowed-third-party-dependency check, all against this table's data-driven mirror (`tools/arch-lint/src/architecture-map.ts`). It currently covers all six shared-layer packages: `canvas-model`, `canvas-codec`, `canvas-render`, `canvas-ports`, `canvas-workspace`, and `server-core`; extend its package list as later shared-layer packages land. Per-package details live in `.claude/rules/package-<name>.md` (path-scoped). Note: `./skills/` (product MCP skills) is unrelated to `.claude/skills/` (dev workflow skills).

The LoroDoc<->model bridge originally scoped for `canvas-codec` is DEFERRED to `canvas-workspace` — a single-document codec has no need for CRDT merge semantics, and pulling `loro-crdt` into this package would violate its own "model + remark only" dependency rule.
