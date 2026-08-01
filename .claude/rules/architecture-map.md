# Architecture Map (OpenCanvas)

Package boundaries are cut by **runtime requirements**, not by feature. The shared layer must run unchanged on Node, the browser, and Cloudflare Workers.

| Package | Role | May depend on |
|---|---|---|
| `packages/canvas-model` | Zod schemas for the OpenCanvas data model (single source of truth) | zod only |
| `packages/canvas-codec` | OKF Markdown / JSON Canvas serialize+parse, remark pipeline | model, remark |
| `packages/canvas-render` | scene graph, layout, SVG backend, sceneDigest | model, zod |
| `packages/canvas-ports` | store/sync port contracts + Symbol `TOKENS` | model, zod |
| `packages/canvas-workspace` | tree ops, alias derivation, index derivation, link extraction | model, codec, ports, loro-crdt |
| `packages/server-core` | `/api/v1` Hono routes + MCP tool definitions, exposed as `createServer(deps)` | workspace, render, hono, zod, loro-crdt |
| `packages/canvas-viewer` | Read-only OpenCanvas scene viewer UI (renders canvas-render SVG), shared between `apps/web` and the MCP Apps widget | model, codec, render, `@modelcontextprotocol/ext-apps`, react, zod |
| `packages/mcp-server` | Node composition root: CLI, stdio, local store impls, resvg, Inversify container | server-core + port impls |
| `apps/web` | Browser composition root: Canvas API backend, IndexedDB store impls, read-write spatial canvas editor | workspace, model, codec, render, canvas-viewer + port impls |

Absolute rules:

1. Shared-layer packages (model / codec / render / ports / workspace / server-core) must not import `node:*`, DOM globals, or `inversify`. `canvas-viewer` is a browser-runtime UI package, so DOM globals are its normal job — it is held only to the `node:*`/`inversify` half of this rule (plus one exempted build-time `Buffer` use in `widget/build-fonts-module.ts`; see its `exemptBoundaryViolationKinds` entry in `architecture-map.ts`).
2. Dependencies flow only in the table's direction. Composition roots (`mcp-server`, `apps/web`) are never imported by shared packages or by `canvas-viewer` — `mcp-server` is registered in `architecture-map.ts` with an empty allowed-dependents list specifically so `direction-check.ts` catches a reverse import.
3. Unsure where code goes → load the `package-placement` skill (planned). DI wiring → `di-container` skill (planned).

These rules are enforced by `tools/arch-lint` (vitest project `arch-lint-node`): a TypeScript-compiler-API scan for banned imports/globals, a package.json dependency-direction check, and a per-package allowed-third-party-dependency check, all against this table's data-driven mirror (`tools/arch-lint/src/architecture-map.ts`). It currently covers all six shared-layer packages (`canvas-model`, `canvas-codec`, `canvas-render`, `canvas-ports`, `canvas-workspace`, `server-core`) plus `canvas-viewer`'s narrower scan; `mcp-server` is registered only for the reverse-dependency-direction guard, not source-scanned (composition roots are allowed `node:*`/`inversify`). Extend the package list as later shared-layer packages land. Per-package details live in `.claude/rules/package-<name>.md` (path-scoped). Note: `./skills/` (product MCP skills) is unrelated to `.claude/skills/` (dev workflow skills).

The LoroDoc<->model bridge originally scoped for `canvas-codec` is DEFERRED to `canvas-workspace` — a single-document codec has no need for CRDT merge semantics, and pulling `loro-crdt` into this package would violate its own "model + remark only" dependency rule.
