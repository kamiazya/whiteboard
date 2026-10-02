# Architecture Map

Package boundaries are cut by **runtime requirements**, not by feature. The shared layer must run unchanged on Node, the browser, and Cloudflare Workers.

| Package | Role | Checked dependencies |
|---|---|---|
| `packages/model` | Zod schemas for the whiteboard document model (single source of truth) | zod only |
| `packages/codec` | OKF Markdown / JSON Canvas serialize+parse, remark pipeline | model, remark |
| `packages/scene` | the scene VOCABULARY and the renderer/plugin contract — what a laid-out document is, and the shape a plugin contributes. Types only; it exists for its position, below both sides | model, facet-engine |
| `packages/canvas-render` | layout, SVG backend, sceneDigest, and the render theme layer (ADR-0030) — the scene vocabulary it produces is `scene`'s | model, codec, scene, plugin-visual, facet-engine, zod, css-line-break, lowlight |
| `packages/ports` | store/sync port contracts + Symbol `TOKENS` | model, zod |
| `packages/facet-engine` | the facet engine (ADR-0013): definePlugin/defineFacet, registry, write validation, compat resolution. Knows no plugin | zod only |
| `packages/search` | lexical search: dictionary-free tokenizer (latin words, CJK bigrams), BM25 ranking, snippets, and the one definition of a document's searchable text | model |
| `packages/loro-adapter` | LoroDoc<->model bridge | model, loro-crdt |
| `packages/reference-graph` | what documents point at: per-document facts, the backlink/mention aggregate, and the digest-validated cache over one keeper port | model, codec, ports, loro-adapter, search, loro-crdt, zod |
| `packages/workspace-index` | the `DocumentIndex` port over a workspace's Loro tree — one implementation for both roots, since a tree-backed index differs between them in nothing | model, ports, loro-adapter, loro-crdt |
| `packages/history` | a document's history as pure mechanics over the workspace record: the checkpoint scheduler, version retention, and frontier encoding. Both keepers run them; where the rows live stays in each root. Branch operations and merge planning lived here until ADR-0029 retired the branch | model, loro-crdt |
| `packages/server-core` | `/api/v1` Hono routes + MCP tool definitions, exposed as `createServer(deps)` | model, codec, canvas-render, ports, loro-adapter, facet-engine, plugin-visual, search, reference-graph, hono, zod, loro-crdt |
| `packages/facet-ui` | the facet system's React half, as a LIBRARY: primitives, the validated writer, the derived form. Knows no plugin | facet-engine, react, lucide-react |
| `packages/plugin-visual` | the bundled `visual` plugin as an ordinary plugin package — data half at `.`, render contribution at `/render`, React half at `/ui`, shortcode tables at `/emoji*` and `/icons/shortcode` | facet-engine, facet-ui, model, scene, react, zod |
| `packages/daemon-client` | the daemon's browser-safe client half: the `/api` Zod contracts the web app parses, the SSE backend and stream hub, `api-client`, the extension bridge, the read-plane and replica-key helpers, and the shared backend contract suites. Extracted from mcp-server so browser-safety is structural (this table scans it); consumed by both roots | model, server-core, zod, @opentelemetry/api, multiformats |
| `packages/canvas-viewer` | Read-only spatial-canvas scene viewer UI (renders canvas-render SVG), shared between `apps/web` and the MCP Apps widget | model, codec, canvas-render, `@modelcontextprotocol/ext-apps`, react, zod |
| `packages/mcp-server` | Node composition root: CLI, stdio, local store impls, resvg, Inversify container | model, codec, canvas-render, canvas-viewer, ports, loro-adapter, facet-engine, plugin-visual, server-core, workspace-index, daemon-client, history |
| `apps/extension` | the browser extension (ADR-0050): relays the hosted app to the native host | daemon-client |
| `apps/web` | Browser composition root: Canvas API backend, IndexedDB store impls, read-write spatial canvas editor, markdown editor | loro-adapter, model, codec, canvas-render, canvas-viewer, ports, facet-engine, facet-ui, plugin-visual, search, reference-graph, workspace-index, daemon-client, history + port impls |

**A third-party dependency is judged by that criterion, not by a quota.** The
`allowedThirdParty` lists in `architecture-map.ts` are a RECORD of what has
been checked against it — not a cap, and not a statement that the shared layer
is closed. A package that runs unchanged on all three runtimes and does not
break the published build may be added; say in the entry what you checked, the
way `css-line-break`'s does ("Pure and DOM-free, so it holds in Node, the
browser and a worker alike — verified before adopting").

What the criterion actually rejects is worth reading, because it is not
weight: BudouX is *vendored* rather than depended on because depending on it
drags in linkedom and the native canvas package and breaks the published
build. Nothing here has ever been refused for being one dependency too many.

This is worded explicitly because the list-shaped enforcement teaches the
opposite. Faced with adding a highlighter that three packages needed, one
session read the list as a wall and seriously considered writing the same
scope-to-role table out three times instead — the dependency was pure JS with
no DOM and no `node:*`, and met the criterion on sight.

Absolute rules:

1. Shared-layer packages (model / codec / render / ports / facet-engine / search / reference-graph / loro-adapter / server-core) must not import `node:*`, DOM globals, or `inversify`. `plugin-visual` is held to the `node:*`/`inversify` half only: its `/ui` half is React by design, while its DEFAULT entry must stay react-free because `canvas-render` imports it — a split no dependency list can see; `plugin-visual-default-entry-react-free.test.ts` holds it. `canvas-viewer` is a browser-runtime UI package, so DOM globals are its normal job — it is held only to the `node:*`/`inversify` half of this rule (plus one exempted build-time `Buffer` use in `widget/build-fonts-module.ts`; see its `exemptBoundaryFiles` entry in `architecture-map.ts`).
2. Dependencies flow only in the table's direction. Composition roots (`mcp-server`, `apps/web`) are never imported by shared packages or by `canvas-viewer` — BOTH are registered in `architecture-map.ts` so `direction-check.ts` catches a reverse import, and both have their own manifest direction-checked via `scan-packages.ts`'s `COMPOSITION_ROOTS` (their SOURCE stays unscanned — they are the packages allowed `node:*`/DOM/inversify). The daemon's browser-safe client half is `daemon-client`, a shared-layer package both roots may consume — apps/web reads it directly, and `mcp-server` inlines it into its published dist via tsdown `noExternal`. Neither root depends on the other; `web-app-boundary.test.ts` pins that apps/web has no `@kamiazya/whiteboard-mcp` import at all. `apps/web` was absent from the table until this guard was added, so a shared package taking a dependency on it would have passed.
3. Unsure where code goes → load the `package-placement` skill (planned). DI wiring → `di-container` skill (planned).
4. What to CALL the thing you are placing is `.claude/rules/vocabulary.md` (always-on): ADR-0009's Document model, plus the standing rule that a session fixes vocabulary violations in whatever it already touches, without preserving backward compatibility for internal names.

These rules are enforced by `tools/arch-lint` (vitest project `arch-lint-node`):
a TypeScript-compiler-API scan for banned imports/globals, a package.json
dependency-direction check, a per-package allowed-third-party-dependency check,
a circular-value-import check, and the adapter-mechanic check described below.
It reads this table's data-driven mirror,
`tools/arch-lint/src/architecture-map.ts`.

Three things it enforces that a session outside `tools/arch-lint` still has to
know, because the reader who trips them is elsewhere:

- **`cycle-check.ts` is static and value-only: a CROSS-PACKAGE cycle is
  invisible to it (`package-cycle-check.ts`), a type one is
  `type-cycle-check.ts`'s.**
- **A package that adds a path alias must declare it** in
  `repo-coverage.test.ts`'s `CYCLE_SCAN_ALIASES`, or that package's edges
  silently leave the cycle graph — 115 of `apps/web`'s 554 while its `@/` was
  live, and the check then reports clean over a picture it cannot see. That
  is executable now: a bare specifier naming no declared dependency is either
  a declared alias prefix or a recorded non-path one (a virtual module), and
  a fabricated record fails too.
- **An ADAPTER may not import a MECHANIC** — `adapter-mechanic-check.ts`
  enforcing [ADR-0018](../../docs/contributing/adr/0018-operation-vs-mechanic.md)'s
  one invariant. An adapter is an HTTP route under `server/routes/**` or an MCP
  tool registration under `server/mcp/**`; a mechanic is anything under
  `server/store/`, at any depth. The composition root's own wiring (`di/`,
  `app.ts`, `http-server.ts`) is deliberately out of scope, since knowing the
  mechanics is its job. The existing edges are allowlisted AND their count is
  pinned by equality, so adding one fails until someone raises the ceiling
  deliberately. ADR-0018 is Accepted and carries the burn-down order.
- **`createServer(deps)` mounts `/api/v1` and the MCP tools only.** The keeper
  protocol the web app syncs through (`/api/sync/*`, workspace-document,
  workspaces, trash, names, files) lives in `mcp-server/src/server/routes/`;
  `route-portability.test.ts` counts which of those files could run off Node
  (shrink-only), and ADR-0052's correction note records that lifting them is
  an open decision.

`apps/web`'s own source is policed by a separate enforcer beside this tool's
scans (`tools/arch-lint/src/web-app-boundary.test.ts`), so "is this checked?"
has two answers depending on the rule. `vocabulary-check.test.ts`
is the mechanical half of `.claude/rules/vocabulary.md`, failing on a retired
word (today `slug`) under `apps/web/src` or `packages/*/src`.

This file is itself guarded: `repo-coverage.test.ts`'s doc-sync block fails
when it stops naming a shared-layer package, a composition root,
`web-app-boundary.test.ts` or `cycle-check.ts` — so an edit that drops one of
those is caught rather than quietly making the map wrong.

Every allowlist in the tool is guarded from both sides, so an entry cannot
outlive the debt it names. What each scan covers, the measurements behind the
lists, and the blind spots found by measuring rather than reading are
`.claude/rules/tool-arch-lint.md`, path-scoped to `tools/arch-lint/**` — a
`tool-` rather than a `package-` rule, because arch-lint lives in `tools/`.
Per-package details are `.claude/rules/package-<name>.md`, likewise
path-scoped. Note: `./skills/` (product MCP skills) is unrelated to
`.claude/skills/` (dev workflow skills).

**Work the daemon does on its own is declared before it is armed.**
`packages/mcp-server/src/server/background-work.ts` is the registry — who runs
it, what it costs the serving loop, what triggers it — and an undeclared worker
does not typecheck. The declared ceilings are `background-work-costs.ts`,
measured by `shared/test-utils/loop-availability.ts` and held by
`background-work.guard.test.ts`. The three questions and the measurements behind
them are `package-mcp-server.md`.

**A cross-package cycle is caught at the MANIFEST level, and there are none
left.** `package-cycle-check.ts` reads every workspace manifest's
`dependencies` AND `devDependencies` (the door the direction check never
inspects) and fails on any package loop not in `KNOWN_PACKAGE_CYCLES` —
which is now EMPTY.

It carried one entry: a source-level loop between `plugin-visual` and `canvas-render` closed only by type-only imports, which no manifest can see. The dissolution landed as `packages/scene`; the history, with a correction, is `package-scene.md`. The guard did not retire with the cycle: `plugin-visual/src/renderer-independence.test.ts` pins that there is no import of the renderer AT ALL, type-only or otherwise.


`lowlight` is a DEFAULT, not an opt-in: `layoutSpatialCanvas` supplies this
package's own tokeniser the way it supplies codec's markdown parser, because
every surface that lays a body out wants it. It shipped opt-in first, behind a
subpath, and a step repeated at four call sites got missed — export drew every
fence plain while the editor coloured it. `highlightCode` remains an option, so a
caller can substitute a tokeniser or pass a no-op.


**What a document points at is resolved in ONE place, and passed as a
bundle.** `canvas-render/src/references/` holds what a keeper loads a reference
into (`LoadedReference`), the one definition of what counts as one
(`referenceTargets`) and the one builder of the four seams a layout reads
(`referenceSeams`). A composition root supplies I/O and passes the bundle as
`references`; it never writes a seam's body — the layout is total, so a seam a
root forgot never failed (the web preview drew a canvas behind `![[path]]` while
`wb_scene_render` refused the document, all green). `tools/arch-lint`'s
`reference-seams-check.test.ts` fails on a seam defined by hand outside that
module; the data form (`ReferenceWire`) for the layout worker and the rest are
`package-canvas-render.md`.


The LoroDoc<->model bridge originally scoped for `codec` is DEFERRED to `crdt` — a single-document codec has no need for CRDT merge semantics, and pulling `loro-crdt` into this package would violate its own "model + remark only" dependency rule.
