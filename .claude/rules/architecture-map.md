# Architecture Map

Package boundaries are cut by **runtime requirements**, not by feature. The shared layer must run unchanged on Node, the browser, and Cloudflare Workers.

| Package | Role | May depend on |
|---|---|---|
| `packages/model` | Zod schemas for the whiteboard document model (single source of truth) | zod only |
| `packages/codec` | OKF Markdown / JSON Canvas serialize+parse, remark pipeline | model, remark |
| `packages/canvas-render` | scene graph, layout, SVG backend, sceneDigest | model, codec, zod, css-line-break, lowlight (`/highlight` subpath only) |
| `packages/ports` | store/sync port contracts + Symbol `TOKENS` | model, zod |
| `packages/loro-adapter` | LoroDoc<->model bridge | model, ports, loro-crdt |
| `packages/server-core` | `/api/v1` Hono routes + MCP tool definitions, exposed as `createServer(deps)` | crdt, render, hono, zod, loro-crdt |
| `packages/canvas-viewer` | Read-only spatial-canvas scene viewer UI (renders canvas-render SVG), shared between `apps/web` and the MCP Apps widget | model, codec, render, `@modelcontextprotocol/ext-apps`, react, zod |
| `packages/mcp-server` | Node composition root: CLI, stdio, local store impls, resvg, Inversify container | server-core + port impls |
| `apps/web` | Browser composition root: Canvas API backend, IndexedDB store impls, read-write spatial canvas editor, markdown editor | loro-adapter, model, codec, render, canvas-viewer, ports, `@kamiazya/whiteboard-mcp`'s browser-safe client subpaths (`/api-client`, `/api-contracts`, `/browser-contract`) + port impls |

Absolute rules:

1. Shared-layer packages (model / codec / render / ports / loro-adapter / server-core) must not import `node:*`, DOM globals, or `inversify`. `canvas-viewer` is a browser-runtime UI package, so DOM globals are its normal job — it is held only to the `node:*`/`inversify` half of this rule (plus one exempted build-time `Buffer` use in `widget/build-fonts-module.ts`; see its `exemptBoundaryViolationKinds` entry in `architecture-map.ts`).
2. Dependencies flow only in the table's direction. Composition roots (`mcp-server`, `apps/web`) are never imported by shared packages or by `canvas-viewer` — BOTH are registered in `architecture-map.ts` specifically so `direction-check.ts` catches a reverse import, and both have their own manifest direction-checked via `repo-coverage.test.ts`'s `COMPOSITION_ROOTS` (their SOURCE stays unscanned — they are the packages allowed `node:*`/DOM/inversify). One composition root may consume the other's browser-safe client subpaths, which is why `apps/web`'s row lists `@kamiazya/whiteboard-mcp`: rule 2 is about a SHARED package importing a root, and the daemon's client contract belongs beside the daemon. `apps/web` was absent from the table until this guard was added, so a shared package taking a dependency on it would have passed.
3. Unsure where code goes → load the `package-placement` skill (planned). DI wiring → `di-container` skill (planned).
4. What to CALL the thing you are placing is `.claude/rules/vocabulary.md` (always-on): ADR-0009's Document model, plus the standing rule that a session fixes vocabulary violations in whatever it already touches, without preserving backward compatibility for internal names. The package names in the table above are themselves on its known-violations list.

These rules are enforced by `tools/arch-lint` (vitest project `arch-lint-node`): a TypeScript-compiler-API scan for banned imports/globals, a package.json dependency-direction check, a per-package allowed-third-party-dependency check, and a circular-value-import check (`cycle-check.ts`, run over `packages/mcp-server/src` + the six shared-layer packages + `canvas-viewer/src`) — value-aware (a `import type`-only edge does not count) and static-analysis-only, so it cannot see a cross-package or path-aliased cycle; `KNOWN_IMPORT_CYCLES` in `architecture-map.ts` is the allowlist for cycles it finds and does not yet fix, and is **currently empty** — `repo-coverage.test.ts` guards it from both sides, failing on a cycle that is not listed and equally on a listed entry that is no longer a real cycle, so an entry cannot outlive the debt it names — all against this table's data-driven mirror (`tools/arch-lint/src/architecture-map.ts`). It currently covers all six shared-layer packages (`model`, `codec`, `canvas-render`, `ports`, `loro-adapter`, `server-core`) plus `canvas-viewer`'s narrower scan. Both composition roots (`mcp-server`, `apps/web`) are registered for the dependency-direction guard only — their source stays unscanned and their third-party surface is open by design, so neither carries an allowed-third-party list. What DOES police `apps/web`'s own source is a separate enforcer outside this tool: `packages/mcp-server/src/server/release/web-app-boundary.test.ts` fails the build when `apps/web` imports a Node builtin or reaches into `src/server`/`src/cli`/`src/daemon`. That split is deliberate — the boundary it guards is the daemon package's own published surface — but it means "is this checked?" has two answers depending on the rule, and only this sentence says so. `tools/arch-lint` also hosts the one part of `.claude/rules/vocabulary.md` that can be mechanical rather than prose: `vocabulary-check.test.ts` fails on a retired word appearing anywhere under `apps/web/src` or `packages/*/src`. Only words with no legitimate meaning left qualify (today: `slug`) — `canvas` never will, because it is correct for the spatial surface and wrong only as the container noun, and telling those apart needs a reader. `migrations/` is excluded as history, and `EXEMPT_FILES` carries the one other file writing history, with its reason. Extend the package list as later shared-layer packages land. Per-package details live in `.claude/rules/package-<name>.md` (path-scoped). Note: `./skills/` (product MCP skills) is unrelated to `.claude/skills/` (dev workflow skills).

`canvas-render/highlight` is the one subpath whose dependencies the barrel does
not carry. It holds the DEFAULT implementation of `layoutMdastBlocks`'
`highlightCode` seam, and it sits in canvas-render because that is the only
package all three surfaces rendering a markdown body can see — `apps/web`'s
editor, `canvas-viewer` (and the MCP Apps widget through it), and
`server-core`/`mcp-server`'s export. The alternative was the same
scope-to-role table written out three times. The seam itself stays in the
barrel and takes any tokeniser, so a consumer that renders no code imports
neither lowlight nor a language grammar.

The LoroDoc<->model bridge originally scoped for `codec` is DEFERRED to `crdt` — a single-document codec has no need for CRDT merge semantics, and pulling `loro-crdt` into this package would violate its own "model + remark only" dependency rule.
