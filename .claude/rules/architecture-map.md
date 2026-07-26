# Architecture Map (OpenCanvas)

Package boundaries are cut by **runtime requirements**, not by feature. The shared layer must run unchanged on Node, the browser, and Cloudflare Workers.

| Package | Role | May depend on |
|---|---|---|
| `packages/canvas-model` | Zod schemas for the OpenCanvas data model (single source of truth) | zod only |
| `packages/canvas-codec` (planned) | OKF Markdown / JSON Canvas serialize+parse, remark pipeline, Loro⇔model | model, loro-crdt, remark |
| `packages/canvas-render` (planned) | scene graph, layout, themes, SVG backend, sceneDigest | model |
| `packages/canvas-ports` (planned) | store/sync port contracts + Symbol `TOKENS` | model |
| `packages/canvas-workspace` (planned) | tree ops, alias derivation, index derivation, link extraction | model, codec, ports |
| `packages/server-core` (planned) | `/api/v1` Hono routes + MCP tool definitions, exposed as `createServer(deps)` | workspace, render |
| `packages/mcp-server` | Node composition root: CLI, stdio, local store impls, resvg, Inversify container | server-core + port impls |
| `apps/web` | Browser composition root: Canvas API backend, IndexedDB store impls | workspace, render + port impls |

Absolute rules:

1. Shared-layer packages (model / codec / render / ports / workspace / server-core) must not import `node:*`, DOM globals, or `inversify`.
2. Dependencies flow only in the table's direction. Composition roots are never imported by shared packages.
3. Unsure where code goes → load the `package-placement` skill (planned). DI wiring → `di-container` skill (planned).

These rules are enforced by boundary lint + dependency-direction tests (introduced with canvas-codec); until those land, review against this table. Per-package details live in `.claude/rules/package-<name>.md` (path-scoped). Note: `./skills/` (product MCP skills) is unrelated to `.claude/skills/` (dev workflow skills).
