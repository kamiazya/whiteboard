# Architecture Map

Package boundaries are cut by **runtime requirements**, not by feature. The shared layer must run unchanged on Node, the browser, and Cloudflare Workers.

| Package | Role | Checked dependencies |
|---|---|---|
| `packages/model` | Zod schemas for the whiteboard document model (single source of truth) | zod only |
| `packages/codec` | OKF Markdown / JSON Canvas serialize+parse, remark pipeline | model, remark |
| `packages/canvas-render` | scene graph, layout, SVG backend, sceneDigest | model, codec, plugin-visual, zod, css-line-break, lowlight |
| `packages/ports` | store/sync port contracts + Symbol `TOKENS` | model, zod |
| `packages/facet-engine` | the facet engine (ADR-0013): definePlugin/defineFacet, registry, write validation, compat resolution. Knows no plugin | zod only |
| `packages/search` | lexical search: dictionary-free tokenizer (latin words, CJK bigrams), BM25 ranking, snippets, and the one definition of a document's searchable text | model |
| `packages/loro-adapter` | LoroDoc<->model bridge | model, ports, loro-crdt |
| `packages/workspace-index` | the `DocumentIndex` port over a workspace's Loro tree — one implementation for both roots, since a tree-backed index differs between them in nothing | model, ports, loro-adapter, loro-crdt |
| `packages/server-core` | `/api/v1` Hono routes + MCP tool definitions, exposed as `createServer(deps)` | crdt, render, facet-engine, plugin-visual, search, hono, zod, loro-crdt |
| `packages/facet-ui` | the facet system's React half, as a LIBRARY: primitives, the validated writer, the derived form. Knows no plugin | facet-engine, react, lucide-react |
| `packages/plugin-visual` | the bundled `visual` plugin as an ordinary plugin package — data half (schemas, resolvers, the icon geometry `visual.symbol` enumerates) at `.`, what it draws ON a node at `/decorations`, React half at `/ui` | facet-engine, facet-ui, model, react, lucide-react, zod; canvas-render TYPE-ONLY (devDependency) |
| `packages/daemon-client` | the daemon's browser-safe client half: the `/api` Zod contracts the web app parses, the fetch/WS/SSE document backends, `api-client`, and the shared backend contract test suites. Extracted from mcp-server's `src/shared` so browser-safety is structural (this table scans it), not positional; consumed directly by both composition roots | model, server-core, zod, @opentelemetry (browser SDK set) |
| `packages/canvas-viewer` | Read-only spatial-canvas scene viewer UI (renders canvas-render SVG), shared between `apps/web` and the MCP Apps widget | model, codec, render, `@modelcontextprotocol/ext-apps`, react, zod |
| `packages/mcp-server` | Node composition root: CLI, stdio, local store impls, resvg, Inversify container | server-core + port impls |
| `apps/web` | Browser composition root: Canvas API backend, IndexedDB store impls, read-write spatial canvas editor, markdown editor | loro-adapter, model, codec, render, canvas-viewer, ports, facet-engine, facet-ui, plugin-visual, search, workspace-index, daemon-client + port impls |

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

1. Shared-layer packages (model / codec / render / ports / facet-engine / search / loro-adapter / server-core) must not import `node:*`, DOM globals, or `inversify`. `plugin-visual` is held to the `node:*`/`inversify` half only: its `/ui` half is React by design, while its DEFAULT entry must stay react-free because `canvas-render` imports it — a split no scan can see, since the package legitimately lists `react`. `canvas-viewer` is a browser-runtime UI package, so DOM globals are its normal job — it is held only to the `node:*`/`inversify` half of this rule (plus one exempted build-time `Buffer` use in `widget/build-fonts-module.ts`; see its `exemptBoundaryViolationKinds` entry in `architecture-map.ts`).
2. Dependencies flow only in the table's direction. Composition roots (`mcp-server`, `apps/web`) are never imported by shared packages or by `canvas-viewer` — BOTH are registered in `architecture-map.ts` specifically so `direction-check.ts` catches a reverse import, and both have their own manifest direction-checked via `repo-coverage.test.ts`'s `COMPOSITION_ROOTS` (their SOURCE stays unscanned — they are the packages allowed `node:*`/DOM/inversify). The daemon's browser-safe client half is `daemon-client`, a shared-layer package both roots may consume — apps/web reads it directly, and `mcp-server` inlines it into its published dist via tsup `noExternal`. No composition root depends on the other any more; `web-app-boundary.test.ts` pins that apps/web has no `@kamiazya/whiteboard-mcp` import at all. `apps/web` was absent from the table until this guard was added, so a shared package taking a dependency on it would have passed.
3. Unsure where code goes → load the `package-placement` skill (planned). DI wiring → `di-container` skill (planned).
4. What to CALL the thing you are placing is `.claude/rules/vocabulary.md` (always-on): ADR-0009's Document model, plus the standing rule that a session fixes vocabulary violations in whatever it already touches, without preserving backward compatibility for internal names. The package names in the table above are themselves on its known-violations list.

These rules are enforced by `tools/arch-lint` (vitest project `arch-lint-node`):
a TypeScript-compiler-API scan for banned imports/globals, a package.json
dependency-direction check, a per-package allowed-third-party-dependency check,
a circular-value-import check, and the adapter-mechanic check described below.
It reads this table's data-driven mirror,
`tools/arch-lint/src/architecture-map.ts`.

Three things it enforces that a session outside `tools/arch-lint` still has to
know, because the reader who trips them is elsewhere:

- **The cycle check (`cycle-check.ts`) is static and value-aware, so a
  CROSS-PACKAGE cycle is invisible to it.** The one that exists is guarded by
  hand, below.
- **A package that adds an `@/...` path alias must declare it** in
  `repo-coverage.test.ts`'s `CYCLE_SCAN_ALIASES`, or that package's edges
  silently leave the cycle graph.
- **An ADAPTER may not import a MECHANIC** — `adapter-mechanic-check.ts`
  enforcing [ADR-0018](../../docs/contributing/adr/0018-operation-vs-mechanic.md)'s
  one invariant. An adapter is an HTTP route under `server/routes/**` or an MCP
  tool registration under `server/mcp/**`; a mechanic is anything under
  `server/store/`, at any depth. The composition root's own wiring (`di/`,
  `app.ts`, `http-server.ts`) is deliberately out of scope, since knowing the
  mechanics is its job. The existing edges are allowlisted AND their count is
  pinned by equality, so adding one fails until someone raises the ceiling
  deliberately. ADR-0018 is Accepted and carries the burn-down order.

`apps/web`'s own source is policed by a separate enforcer outside this tool
(`packages/mcp-server/src/server/release/web-app-boundary.test.ts`), so "is
this checked?" has two answers depending on the rule. `vocabulary-check.test.ts`
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
`packages/mcp-server/src/server/background-work.ts` is the registry, and the
composition roots start and stop everything through it. Adding a scheduler, a
sweeper, a poller, or a dispatcher means editing that file and answering three
questions the diff would otherwise never ask:

- **who runs it** when several instances share one record — `leader-only`
  (naming the lease) or `every-instance` (saying why that is right, since it
  is also what a worker gets by accident);
- **what it costs the serving loop** — `subprocess`, or `in-process` with a
  `stallCeilingMs` **a test asserts on every run**, taken with
  `shared/test-utils/loop-availability.ts` rather than by hand;
- **what triggers it**.

Both of the first two were got wrong on one worker, invisibly. The backup pass
ran on every instance (N backups a night, and N retention passes each deleting
from a set the others were changing) and inside the serving process, where
`VACUUM INTO` blocks the event loop for its whole duration — 1242ms at a 103MB
database, 4767ms at 421MB, and rising with the data. Nothing in the source says
a call blocks: an `await` on a native binding reads exactly like an `await` on a
socket. `snapshot-blocking.test.ts` pins that one so the decision that put a
subprocess in the way fails loudly if the call ever stops blocking.

A ceiling rather than a reading, because a reading goes stale in silence. The
field first held `0` on three declarations, each with a date and no
measurement behind it. Naming the source test in a `fixture` string was meant
to fix that and did not: the workspace tail then declared 283ms while citing a
test that measures 20-29ms — the number came from a scratch script at a larger
fixture, and the citation was written from memory. **A number with a source
named beside it is still unbacked if nothing reads the source.** So the
declarations live in `background-work-costs.ts` where a test can import them,
each loop-availability test asserts its own measurement stays under its
ceiling, and `background-work-costs.test.ts` fails on a declared ceiling no
test asserts — with an exemption list guarded from both sides, for the one
worker (`idle-shutdown`) that compares two timestamps and has no call to
measure. Larger hand-measured points stay in `fixture`, said plainly to be
hand measurements: they are what a reader sizing a deployment needs and
exactly what a test on a small fixture cannot check.

The instrument itself is calibrated against known truths in
`loop-availability.test.ts`, which is not ceremony — it was written, trusted
for three declarations, and only calibrated after the fact, at which point
`worstStallMs` turned out to report **0.3ms for a 200ms stall** whenever the
stall ran to the end of the body.

The registry is load-bearing rather than advisory — an undeclared worker does
not typecheck, and `background-work.guard.test.ts` fails on a `.start()` in a
composition root that goes around it. What it does NOT catch is a worker that
arms itself at module load or from somewhere else; that is what this paragraph
is for, and prose is the weaker rung on purpose. The registry earned its keep
on the first read: `server-mode-http.ts` — the MULTI-INSTANCE root, the one the
backup lease was built for — was starting no background work at all, so
scheduled backups reached only the local daemon.

**A cross-package cycle is caught at the MANIFEST level, and its type-only
property by a hand guard.** `plugin-visual` imports `canvas-render`'s
scene-node vocabulary to build the decorations `canvas-render` then uses as
its default — a source-level loop closed only by the import being TYPE-ONLY.
`package-cycle-check.ts` now reads every workspace manifest's `dependencies`
AND `devDependencies` (the door the direction check never inspects) and
fails on any package loop not in `KNOWN_PACKAGE_CYCLES`, which carries this
one edge with its reason. What stays hand-guarded is the type-only property
itself — the manifest cannot see it, and measured, turning the import into
a value import leaves the rest of arch-lint green:
`plugin-visual/src/canvas-render-type-only.test.ts` is what fails, naming
the offending line. The honest dissolution is a package below both holding
the scene vocabulary, since it is a contract between the renderer and every
plugin rather than the renderer's private type; worth extracting when a
second plugin needs it, and recorded on `decorations.ts` until then.

`lowlight` is a DEFAULT, not an opt-in. `layoutSpatialCanvas` supplies this
package's own tokeniser the way it already supplies codec's markdown parser,
because every surface that lays a markdown body out wants it — the editor,
`canvas-viewer` (and the MCP Apps widget through it), and
`server-core`/`mcp-server`'s export — and the one that forgets it does not
fall back to the same picture, it draws code plain while the others colour it.

It was shipped opt-in first, behind a subpath, and that is why this paragraph
exists: an opt-in step in four call sites is a step that gets missed, and it
was — wired at one, leaving export drawing every fence plain. `highlightCode`
remains an option, so a caller can substitute a tokeniser or pass a no-op; only
the direction of the default changed.

**What a document points at is resolved in ONE place, and the seams it
produces are passed as a bundle.** `canvas-render/src/references/` holds the
record every keeper loads a document into (`LoadedReference`: name, raw body
or canvas), the one definition of what counts as a reference
(`referenceTargets`: a body's `[[…]]`/`![[…]]`, a canvas's file nodes), and
the one builder of the four seams a layout reads (`referenceSeams`:
`resolveAlias`/`resolveTitle`/`resolveEmbed`/`resolveReference`). A
composition root supplies I/O — reach the store for one reference — and
passes the bundle as `references`; it never writes a seam's body. The layout
is total by design, so a seam a root forgot never failed: the web preview
drew a canvas behind `![[path]]` while `wb_scene_render` refused the
document, and the daemon answered file references with bodies while the
browser answered canvases too, all green. `tools/arch-lint`'s
`reference-seams-check.test.ts` fails on a seam defined by hand outside that
module (passing one along, wrapping it with `overlayReferences`, or handing
the builder a page's alias table is fine). The gap that remains, stated so
nobody rediscovers it: the editor's canvas text-node bodies still take no
markdown seams, because the layout worker cannot receive a function and the
worker and main-thread renders of one canvas must not disagree.

The LoroDoc<->model bridge originally scoped for `codec` is DEFERRED to `crdt` — a single-document codec has no need for CRDT merge semantics, and pulling `loro-crdt` into this package would violate its own "model + remark only" dependency rule.
