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
| `packages/canvas-viewer` | Read-only spatial-canvas scene viewer UI (renders canvas-render SVG), shared between `apps/web` and the MCP Apps widget | model, codec, render, `@modelcontextprotocol/ext-apps`, react, zod |
| `packages/mcp-server` | Node composition root: CLI, stdio, local store impls, resvg, Inversify container | server-core + port impls |
| `apps/web` | Browser composition root: Canvas API backend, IndexedDB store impls, read-write spatial canvas editor, markdown editor | loro-adapter, model, codec, render, canvas-viewer, ports, facet-engine, facet-ui, plugin-visual, search, workspace-index, `@kamiazya/whiteboard-mcp`'s browser-safe client subpaths (`/api-client`, `/api-contracts`, `/browser-contract`) + port impls |

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
2. Dependencies flow only in the table's direction. Composition roots (`mcp-server`, `apps/web`) are never imported by shared packages or by `canvas-viewer` — BOTH are registered in `architecture-map.ts` specifically so `direction-check.ts` catches a reverse import, and both have their own manifest direction-checked via `repo-coverage.test.ts`'s `COMPOSITION_ROOTS` (their SOURCE stays unscanned — they are the packages allowed `node:*`/DOM/inversify). One composition root may consume the other's browser-safe client subpaths, which is why `apps/web`'s row lists `@kamiazya/whiteboard-mcp`: rule 2 is about a SHARED package importing a root, and the daemon's client contract belongs beside the daemon. `apps/web` was absent from the table until this guard was added, so a shared package taking a dependency on it would have passed.
3. Unsure where code goes → load the `package-placement` skill (planned). DI wiring → `di-container` skill (planned).
4. What to CALL the thing you are placing is `.claude/rules/vocabulary.md` (always-on): ADR-0009's Document model, plus the standing rule that a session fixes vocabulary violations in whatever it already touches, without preserving backward compatibility for internal names. The package names in the table above are themselves on its known-violations list.

These rules are enforced by `tools/arch-lint` (vitest project `arch-lint-node`): a TypeScript-compiler-API scan for banned imports/globals, a package.json dependency-direction check, a per-package allowed-third-party-dependency check, and a circular-value-import check (`cycle-check.ts`, run over `packages/mcp-server/src` + the eight shared-layer packages + `canvas-viewer/src` + `apps/web/src`) — value-aware (a `import type`-only edge does not count) and static-analysis-only, so it cannot see a cross-package cycle; it DOES follow an `@/...` path alias, and had to before `apps/web` could join, because that package writes 115 of its 554 intra-package value edges that way — a fifth. Measured: with the alias resolution removed, a real two-file cycle planted in `apps/web/src` passes the guard green. Declare an alias in `repo-coverage.test.ts`'s `CYCLE_SCAN_ALIASES` when a package adds one, or its edges silently leave the graph; `KNOWN_IMPORT_CYCLES` in `architecture-map.ts` is the allowlist for cycles it finds and does not yet fix, and is **currently empty** — `repo-coverage.test.ts` guards it from both sides, failing on a cycle that is not listed and equally on a listed entry that is no longer a real cycle, so an entry cannot outlive the debt it names — all against this table's data-driven mirror (`tools/arch-lint/src/architecture-map.ts`). It currently covers all eight shared-layer packages (`model`, `codec`, `canvas-render`, `ports`, `facet-engine`, `search`, `loro-adapter`, `server-core`) plus `canvas-viewer`'s narrower scan. Both composition roots (`mcp-server`, `apps/web`) are registered for the dependency-direction guard, and both now have their `src` in the cycle scan too; what stays unscanned for them is the BOUNDARY scan (banned imports/globals), and their third-party surface is open by design, so neither carries an allowed-third-party list. What DOES police `apps/web`'s own source is a separate enforcer outside this tool: `packages/mcp-server/src/server/release/web-app-boundary.test.ts` fails the build when `apps/web` imports a Node builtin or reaches into `src/server`/`src/cli`/`src/daemon`. That split is deliberate — the boundary it guards is the daemon package's own published surface — but it means "is this checked?" has two answers depending on the rule, and only this sentence says so. `adapter-mechanic-check.ts` enforces [ADR-0018](../../docs/contributing/adr/0018-operation-vs-mechanic.md)'s
one invariant: an ADAPTER (an HTTP route under `server/routes/**`, or an MCP
tool registration under `server/mcp/**`) may not import a MECHANIC (anything
under `server/store/`). The composition root's own wiring — `di/`, `app.ts`,
`http-server.ts` — is deliberately out of scope, since knowing the mechanics
is its job. `ADAPTERS_REACHING_MECHANICS` in `architecture-map.ts` records
the 35 edges that exist today and may only SHRINK: an unlisted edge fails
the build, and a listed edge that no longer exists fails it too, so an entry
cannot outlive the debt it names. `corrupt-stored-data` is excluded and says
why — an error taxonomy an adapter reads to pick a status code is
translation, which is an adapter's job, and listing it would put five
permanently-unshrinkable entries in a list whose whole value is that it
shrinks.

A mechanic is named by its FULL path under `store/`, at whatever depth, so
the database layer reads as `db/<module>`. It used to be invisible: the
matcher read a single path segment, so every `store/db/**` import from an
adapter passed the guard silently. That was a blind spot rather than a
decision, and it read as coverage until someone measured it — four such
edges existed when the regex was widened, all under `mcp/`. The depth is
unbounded on purpose: `store/db/` is how deep the tree happens to go today,
not a property of it, and a matcher enumerating the depths it has seen is
the same blind spot one directory further down.

The wiring exemption above is a DIRECTORY list, which misses a composition
root that happens to live inside an adapter tree. `ADAPTER_SCAN_EXEMPT_FILES`
carries those by file, with the reason each is not an adapter — today
`mcp/index.ts`, the McpServer factory and stdio entry point, which makes the
same `createContainer` / `resolveServerDeps` calls `http-server.ts` does. It
is a separate list from `ADAPTERS_REACHING_MECHANICS` on purpose: an
exemption is a CLASSIFICATION, not debt, and a composition root's edges will
never shrink. Guarded from both sides like the allowlist — an entry that
suppresses nothing fails the build, so it cannot decay into decoration.

The other file that reached `store/db` from under `mcp/` was moved instead
of exempted. `mcp/session-resolver.ts` had stopped being an MCP concern the
moment `http-server.ts` called it, so it is now `server/current-workspace.ts`
— which also retires a name that said `session` about a workspace.

`tools/arch-lint` also hosts the one part of `.claude/rules/vocabulary.md` that can be mechanical rather than prose: `vocabulary-check.test.ts` fails on a retired word appearing anywhere under `apps/web/src` or `packages/*/src`. Only words with no legitimate meaning left qualify (today: `slug`) — `canvas` never will, because it is correct for the spatial surface and wrong only as the container noun, and telling those apart needs a reader. `migrations/` is excluded as history, and `EXEMPT_FILES` carries the one other file writing history, with its reason. Extend the package list as later shared-layer packages land. Per-package details live in `.claude/rules/package-<name>.md` (path-scoped). Note: `./skills/` (product MCP skills) is unrelated to `.claude/skills/` (dev workflow skills).

**Work the daemon does on its own is declared before it is armed.**
`packages/mcp-server/src/server/background-work.ts` is the registry, and the
composition roots start and stop everything through it. Adding a scheduler, a
sweeper, a poller, or a dispatcher means editing that file and answering three
questions the diff would otherwise never ask:

- **who runs it** when several instances share one record — `leader-only`
  (naming the lease) or `every-instance` (saying why that is right, since it
  is also what a worker gets by accident);
- **what it costs the serving loop** — `subprocess`, or `in-process` with a
  MEASURED figure and the date, taken with
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

The registry is load-bearing rather than advisory — an undeclared worker does
not typecheck, and `background-work.guard.test.ts` fails on a `.start()` in a
composition root that goes around it. What it does NOT catch is a worker that
arms itself at module load or from somewhere else; that is what this paragraph
is for, and prose is the weaker rung on purpose. The registry earned its keep
on the first read: `server-mode-http.ts` — the MULTI-INSTANCE root, the one the
backup lease was built for — was starting no background work at all, so
scheduled backups reached only the local daemon.

**A cross-package cycle is caught by nothing, so the one that exists is
guarded where it is.** `plugin-visual` imports `canvas-render`'s scene-node
vocabulary to build the decorations `canvas-render` then uses as its default —
a source-level loop closed only by the import being TYPE-ONLY. Nothing
mechanical holds that: the cycle check is intra-package, and the direction
check reads `dependencies` while this edge sits in `devDependencies`, which it
documents as never inspected. Measured — turning the import into a value
import left all 102 arch-lint tests green.
`plugin-visual/src/canvas-render-type-only.test.ts` is what actually fails,
naming the offending line. The honest fix is a package below both holding the
scene vocabulary, since it is a contract between the renderer and every plugin
rather than the renderer's private type; worth extracting when a second plugin
needs it, and recorded on `decorations.ts` until then.

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

The LoroDoc<->model bridge originally scoped for `codec` is DEFERRED to `crdt` — a single-document codec has no need for CRDT merge semantics, and pulling `loro-crdt` into this package would violate its own "model + remark only" dependency rule.
