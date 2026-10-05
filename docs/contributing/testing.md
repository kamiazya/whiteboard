# Testing Strategy

This document is the canonical reference for testing philosophy, layer selection,
property-based testing, mutation testing, and quality gates in this repo.

- [CONTRIBUTING.md](../../CONTRIBUTING.md) — contributor workflow (quick-start, commits, lint, release)
- [AGENTS.md](../../AGENTS.md) — agent-specific operational rules (MCP dev mode, Zod discipline, PR rules)

---

## Philosophy

Passing tests alone are not sufficient. The workflow is:

1. Write the smallest failing test at the nearest layer.
2. Make the smallest patch that turns it green.
3. Manually verify the real behavior (browser, MCP smoke, or daemon log).
4. Lock the verified flow into `canvas-viewer-browser`/`web-browser` or E2E coverage.

Skip step 3 only for pure helper changes with no observable runtime effect. Skip step 4 only when the verified scenario is already covered by an existing automation.

---

## Standard Workflow

```bash
# 1. Run the narrowest project first
pnpm test --project mcp-node
pnpm --filter @kamiazya/whiteboard-web test   # apps/web jsdom, when the change touches UI

# 2. After targeted test passes, run the broader gate for the touched area
#    (not the whole repo: CI runs the full matrix on every push)
pnpm check:local         # every gate CI's check job runs
pnpm test:browser        # for browser-mode changes (canvas-viewer-browser + web-browser + canvas-render-browser + web-browser-window-state)
pnpm smoke:e2e           # for MCP tool / route / protocol changes
pnpm test:e2e:distribution # for packaged daemon / tarball / binary behavior (spends API quota: it chains the claude and codex CLI smokes, which skip when the CLI is absent)
```

A pull request that touches test files also runs CI's `stress-changed-tests` job: every changed
test file five times in fresh processes, then once with `--repeats=3` in one process, once for the
browser projects and once for the rest. A test that passes alone but leaves state behind for its own
next repetition (a fixed id seeded into IndexedDB with no per-test reset, say) is first seen red
there. `node .claude/scripts/stress-changed.mjs` runs the same thing locally against the files
changed since `origin/main` (`--base=<ref>` to change the base, `--only=node` or `--only=browser`
for one leg, `--dry-run` to print the plan); a test in `tools/arch-lint` keeps it in step with the
job.

---

## Test Layer Selection

Choose the **narrowest** layer that can prove the behavior:

| Layer | Config | When to use |
|---|---|---|
| `mcp-node` | `vitest.node.config.ts` (`packages/mcp-server`) | Pure functions, stores, routes, server behavior, persistence logic, schemas, CLI helpers |
| `arch-lint-node` | `vitest.node.config.ts` (`tools/arch-lint`) | A guard over files that belong to no one package: workflows, the Dockerfile, root manifests, docs, the rule corpus, `apps/web`'s source, and the architecture boundaries. It reads text and runs no product code, so it runs at pre-push and in CI's `test-shared` on every change. A test under `packages/*/src` that reads a repo-root file belongs here unless `repo-root-reads.test.ts` lists it with a reason |
| `canvas-viewer-node` / `canvas-viewer-jsdom` | `vitest.node.config.ts` / `vitest.jsdom.config.ts` (`packages/canvas-viewer`) | `packages/canvas-viewer` parsing, hooks, and components when browser layout and pointer behavior are **not** the core risk |
| apps/web jsdom | `apps/web/vitest.config.ts` | React components and hooks when real layout, focus, pointer, or browser APIs are **not** the core risk |
| `web-browser` | `apps/web/vitest.browser.config.ts` | `apps/web` tests that need real browser APIs unavailable in jsdom: IndexedDB, OPFS, `window.showOpenFilePicker`, popovers/dialogs/focus/scroll/restore flows, and other platform APIs. File suffix: `.browser.test.tsx` |
| E2E | `tests/e2e/` | Real routes, server composition, sync-stream (SSE) timing, daemon process lifecycle, persistence order, packaging, or multi-step product journeys |

The UI lives solely in `apps/web` since the MCP-UI retirement (ADR 0001); `packages/mcp-server` is backend-only and has no jsdom/browser layer of its own.

**Promotion rules:**

- Do not jump to broad E2E first if a smaller failing test can isolate the bug.
- When an E2E catches a bug, add the nearest-layer test as well unless the root cause only exists at the composed-system boundary.
- Prefer `web-browser` over apps/web jsdom whenever the scenario involves focus, pointer, dialog, popover, scroll, or restore behavior.

**Server logs under `mcp-node`.** The suite drives refusals, corrupt rows and thrown handlers on
purpose, so `vitest.log-setup.ts` turns off the logger's default stderr destination for the
project: a passing run prints no pino records. Records still reach every other destination, so
assert on them with `captureLogsForTests(level)` (and `restore()` in `afterEach`). A test that
asserts on the line stderr itself receives opts back in with `setStderrLogDestination(true)` and
calls the restore it returns — the same call, in the failing test, shows its records while you
diagnose it. Only the test setup calls the switch; the daemon and the packaged entry always log to
stderr, and a process a test spawns keeps its own stderr.

---

## Property-Based Testing

Use PBT when the behavior is better described as an invariant over many inputs than as one fixed example.

**Prefer PBT for:**

- Process-boundary contracts: MCP tool schemas, HTTP response schemas, persisted JSON parsers
- Security boundaries: auth routing, Origin/CORS policy, path confinement, token redaction
- Migration and compatibility logic: old/new versions, malformed payloads, unknown fields
- State machines: browser document controller, daemon lifecycle, head/version state
- Concurrency and race risks: save/export/import ordering, late failures, retry/reload behavior

**File naming:**

- `*.property.test.ts` — invariant tests over generated inputs
- `*.model.test.ts` / `*.model.test.tsx` — model-based state-machine tests
- `*.race.test.ts` / `*.race.test.tsx` — scheduler or ordering tests

**Shared utilities:**

- Import `fc`, `fcTest` and `withDefaults` from the package's own `test-utils/fast-check.ts` (in `mcp-server`, `src/shared/test-utils/fast-check.ts`) instead of importing `fast-check` directly. Each of those files re-exports the one prelude in `@kamiazya/whiteboard-model/test-utils`, and `tools/arch-lint/src/fast-check-prelude-check.test.ts` fails a package that defines its own.
- Arbitraries that generate valid model values (nodes, edges, canvases, a schema's own `zod-arbitrary`) live in `packages/model/src/test-utils/` and are exported through that same `@kamiazya/whiteboard-model/test-utils` entry, so codec, canvas-render and the rest share them rather than copy them. An arbitrary that only one package needs stays in that package's `test-utils/`.

**Replayability:** Avoid `Math.random()`, wall-clock timing, real network, and unseeded global state inside generated runs.

---

## Mutation Testing

Use [StrykerJS](https://stryker-mutator.io/) for mutation testing on the configured target set.

```bash
pnpm mutation:contracts
```

This runs Stryker with `packages/mcp-server/stryker.config.mjs`, which uses a dedicated Vitest config (`vitest.stryker.config.ts`) to keep the dry run stable. **Do not use `vitest.stryker.config.ts` for normal test runs or CI** — use `vitest.node.config.ts` instead.

That config includes only the tests that can reach a mutated module — every test that imports one, directly or through the modules between — rather than the whole `mcp-node` suite. The set is computed from the source's import graph (`packages/mcp-server/scripts/mutation/covering-tests.mjs`) each time the config loads, so a test that starts importing a mutated module joins the lane without a list to edit. Stryker abandons the lane when its initial run outlasts `dryRunTimeoutMinutes` (set in the Stryker config, with the duration it was sized from) or when any test in that run fails, so a test that reads the machine it runs on cannot be in it.

### Purpose and scope

Mutation testing checks whether the current test suite notices plausible implementation changes. It is a complement to example tests and PBT, not a replacement.

Keep Stryker scope **narrow**:

- Intended for contract/helper surfaces: schemas, parsers, diagnostics redaction, path guards, small pure helpers.
- Do **not** expand runs to browser-mode, Playwright E2E, canvas-render/canvas-viewer SVG rendering, daemon lifecycle smokes, or broad React interaction flows unless a dedicated Stryker target is added for that surface.

### Survivor classification

When Stryker reports survived mutants, classify each one before acting:

| Class | Description | Action |
|---|---|---|
| **Real risk** | Mutant represents a behavior change a user or contract would notice | Add a deterministic regression or PBT property that kills it |
| **Equivalent** | Mutant produces identical observable behavior (e.g. `>= 0` vs `> -1` on integers) | Report as equivalent in PR body; no new test needed |
| **perTest-escaping** | Test suite does cover the line but Stryker's per-test coverage or related-test selection does not select the killing test | Document position; confirm with a focused manual check |
| **Intentionally permissive** | Contract deliberately allows a range of values that the mutant also satisfies | Note the intent in the PR body; no test needed |

Do not chase 100% mutation score as a product goal. Equivalent mutants and intentionally permissive contracts are normal.

### Target selection rules

Add a file to the mutation target set when:

- It implements a security boundary (auth, CORS, path confinement, token redaction).
- It parses or validates a cross-process contract (MCP schema, HTTP schema, persisted JSON).
- It implements a state-machine transition or diagnostic aggregation logic.
- Example and PBT coverage already exists and a mutation run would add clear signal.

Do **not** add browser-only components, Playwright helpers, daemon process orchestration, or files whose only tests are Stryker-incompatible (e.g. `vi.spyOn(process.stderr, 'write')` conflicts with Stryker's worker isolation).

### Production code policy

Treat surviving mutants as review input, not as automatic justification for changing production behavior. Before changing a parser or guard based on a mutation survivor:

1. Confirm the mutant represents a real product or contract risk (not an equivalent mutant).
2. Ensure the change is consistent with the stated contract and existing tests.
3. Add a concrete regression or PBT that would have caught the original gap.

If a surviving mutant reveals a gap but the production fix is out of scope for the current PR, file it as a whiteboard document of `type: issue` (see the `ticketing` skill, `.claude/skills/ticketing/SKILL.md`) and address it separately.

### Current mutation target set

The target list is not copied here, because a copy goes stale silently: the files that own it are `packages/mcp-server/stryker.config.mjs` (the `mutate` array run by `pnpm mutation:contracts`) and, for `canvas-render`'s separate lane, `packages/canvas-render/stryker-targets.mjs`. Both are guarded — `tools/arch-lint/src/stryker-targets.test.ts` fails on a `mutate` entry that names no file, and `canvas-render`'s `mutation-lane-coverage.test.ts` pins its list exactly.

---

## Browser Testing

The real-browser Vitest projects are below. The root `vitest.config.ts` owns the list; `docs-contract.test.ts` fails if this table stops naming one:

| Project | Package | Purpose |
|---|---|---|
| `canvas-render-browser` | `packages/canvas-render` | Cross-platform SVG-serialization determinism: the same scene must render byte-identical SVG in a real browser as it does in `canvas-render-node` |
| `canvas-viewer-browser` | `packages/canvas-viewer` | Popovers, dialogs, scroll, focus, keyboard, pointer, and restore flows where browser layout and pointer behavior are the core risk |
| `web-browser` | `apps/web` | `apps/web` app browser regressions: popovers, dialogs, focus, keyboard, restore flows, and tests requiring real browser APIs unavailable in jsdom (IndexedDB, OPFS, `window.showOpenFilePicker`) |
| `web-browser-window-state` | `apps/web` | Tests that leave the browser WINDOW in a state the next file cannot tolerate (today: entering real fullscreen, after which Chromium refuses `page.viewport`). Named `*.window-state.browser.test.tsx` and run alone — the reason is in `apps/web/vitest.browser-window-state.config.ts` |

```bash
pnpm run test:browser         # canvas-viewer-browser + web-browser + canvas-render-browser + web-browser-window-state
pnpm run test:browser:replay  # same, plus a step-by-step DOM replay of EVERY test in .vitest/index.html
pnpm run test:browser:trace   # same, plus a Playwright trace for EVERY test and its DOM snapshots
```

The default run retains a Playwright trace only for a FAILING test, and that
trace has no DOM view — action log, stacks and screenshots, but no time-travel
through the page. Two ways to get one:

- `test:browser:replay` turns on vitest's `browser.traceView` and the HTML
  reporter: a DOM snapshot at every interaction and assertion, replayed in
  `.vitest/index.html` (open it in a browser) with the failed step in red.
  It records DOM snapshots rather than served resources, so it is cheap
  enough to cover every test: measured on `apps/web`'s 20 page files, the
  report data was 774KB gzipped with replays against 177KB without.
- `test:browser:trace` records Playwright's own DOM snapshots, which means
  every resource vite served — 302MB against 7.5MB on 16 page files and 22GB
  over a whole `web-browser` run. Use it for ONE failing file when the
  network log or the provider's screenshots are what you need.

**jsdom exclude policy**: apps/web's jsdom config must exclude `.browser.test.ts` and `.browser.test.tsx` files. Tests that depend on IndexedDB or other real browser APIs belong in `web-browser`, not jsdom. Mixing them causes silent no-op failures or missing-API errors.

Failure traces are stored under `<package>/tmp/vitest-traces` — `packages/canvas-render/tmp/vitest-traces` for `canvas-render-browser`, `packages/canvas-viewer/tmp/vitest-traces` for `canvas-viewer-browser`, `apps/web/tmp/vitest-traces` for `web-browser`. Check traces before adding temporary debug code. Remove temporary debug overlays and instrumentation before finishing.

In CI the runner is discarded with those files, so a browser job that fails uploads them as an artifact, kept for 7 days: `browser-traces-test-browser-<shard>-attempt-<n>` from `test-browser`, and `browser-traces-stress-changed-tests-attempt-<n>` from the browser leg of `stress-changed-tests`. A CI-only failure often prints nothing but the trace's path, with no source frame; the stack is in the trace. Fetch it with `gh run download <run-id> --pattern 'browser-traces-*'` and open the `.trace.zip` with `pnpm --filter @kamiazya/whiteboard-web exec playwright show-trace <file>`.

Prefer `web-browser` over apps/web jsdom whenever the scenario involves:
- Focus, pointer, keyboard, or scroll behavior
- Popover or dialog lifecycle (opening, closing, trap focus)
- Restore flows that depend on real DOM timing
- Any behavior where jsdom silently falls back to no-op
- IndexedDB, OPFS, or other real browser APIs not available in jsdom

---

## E2E Testing

Use E2E when the behavior depends on real app composition rather than an isolated unit, store, route helper, hook, or component seam.

**Prefer E2E for:**

- Real routes, server middleware, sync-stream (SSE) timing, daemon startup/shutdown, and persistence order
- Browser-to-daemon migration journeys
- Packaged CLI, tarball, binary, and install-layout behavior
- MCP protocol smoke flows that must validate the real server entrypoint
- User journeys where mocks would hide routing, runtime config injection, or process-boundary behavior

**Do not use E2E** for pure parsing, schema validation, isolated store logic, or component state testable in `mcp-node`, apps/web jsdom, or `web-browser`.

**E2E placement:**

- `tests/e2e/distribution/` — packaged daemon, server-mode, tarball, and install-layout smokes, plus the release-gate matrix that lists them (see its `README.md`). This is the only directory under `tests/e2e/` today.
- MCP protocol smokes are not under `tests/e2e/`: the shared implementations live in `packages/mcp-server/src/server/mcp/*.smoke-impl.ts` and the CLI wrappers in `packages/mcp-server/scripts/smoke/` (see Smoke & Distribution Tests below).
- Real-browser regressions are Vitest browser projects (see Browser Testing above); the one browser-driving smoke in the distribution chain is `pnpm smoke:read-plane`, listed in `tests/e2e/distribution/README.md`.

Keep E2E suites small and focused. If E2E finds a bug, add the nearest-layer regression unless the root cause only exists at the composed-system boundary.

---

## Smoke & Distribution Tests

MCP startup, protocol, and distribution-artifact smokes run as Vitest projects. The shared implementations under `src/server/mcp/*.smoke-impl.ts` and `*.distribution-impl.ts` are used by both the Vitest tests and the `scripts/smoke/mcp-*.mjs` CLI wrappers.

### `mcp-smoke` — included in `pnpm test`

Runs alongside `mcp-node` during normal `pnpm test`. No build prerequisite. The project runs with `maxWorkers: 1` (`packages/mcp-server/vitest.smoke.config.ts`), so each test's daemon process runs alone; the daemon listens on an owner-only socket rather than a TCP port (ADR-0050), so this is about process and data-dir contention, not port conflicts.

| Script | What it covers |
|---|---|
| `pnpm smoke` | Startup-only: MCP server starts without fatal errors and stays alive for 3 s |
| `pnpm smoke:e2e` | Full stdio MCP round-trip: `wb_workspace_edit` → `wb_facet_set` → `wb_canvas_edit` (seed, duplicate-id / dangling-endpoint / locked refusals, rejected-batch rollback, tidy) → `wb_scene_render` / `wb_canvas_snapshot` (default, and `layout:true`) / `wb_viewport_set` → version save/list/restore → `document.set` → `wb_document_get` |

Run all mcp-smoke tests together:

```bash
pnpm --filter @kamiazya/whiteboard-mcp test:smoke    # vitest run --project mcp-smoke
```

### `mcp-distribution` — opt-in, requires build

Not included in `pnpm test`. Requires `dist/server/mcp/stdio.js` to exist. `test:distribution` includes the build step; individual `smoke:*` scripts do not (CI builds before calling them). Tests run sequentially, one packaged daemon at a time.

| Script | What it covers | Build included |
|---|---|---|
| `pnpm smoke:packaged` | Packaged `dist/server/mcp/stdio.js` passes full e2e checkpoint flow | No |
| `pnpm smoke:tarball` | `npm pack` → install → installed entry passes full e2e checkpoint flow | No |
| `pnpm smoke:codex-config` | Plugin manifest + published MCP config valid; packaged entry starts | No |
| `pnpm test:distribution` | All three above, after `pnpm build` | Yes |

### Real-browser smokes — opt-in, require `pnpm build` + Chromium

Not included in `pnpm test` or `test:distribution`. Each launches a real
Chromium (via Playwright) against a real daemon and the real built web app,
reached through the extension (ADR-0050), so they live in
`apps/extension/scripts/`, build the extension and the web app themselves,
and need Playwright's own Chromium
(`pnpm --filter @kamiazya/whiteboard-extension exec playwright install
chromium`).

`smoke:read-plane` joined last: its replica pull used to fail to fire in 2 of 6
local runs — a race between a daemon deep link's reconnection and the
browser-keeper address rewrite, fixed by `awaitingDaemonRenewal` in
`use-workspace-address-sync.ts`. It used to check a removed member and a
revoked origin grant too; those were local member management and pairing,
which ADR-0050 retired.

| Script | What it crosses for real |
|---|---|
| `pnpm --filter @kamiazya/whiteboard-extension smoke:bridge` | A page reaching the daemon through the extension, the native host and the owner-only socket: the daemon's credential rather than the page's, an SSE stream as written, the web app editing live, and a browser-kept record promoted into a daemon workspace (an attested promote refused) |
| `pnpm smoke:read-plane` | Through the extension (ADR-0050): a sealed replica in real IndexedDB, the real locked page a cold start lands on with the daemon gone, and the daemon page back on Reconnect (ADR-0042). Lives in `apps/extension/scripts/` and needs the extension build |

Every one of these fakes something in the Vitest browser-mode suites — the
daemon at `fetch`, the browser's own routing, or the extension — so this
is the one place each side meets what the other actually produces.

### External CLI smokes — not Vitest, require external tooling

These scripts require a running Claude or Codex CLI and consume API quota. Not included in `pnpm test` or `test:distribution`.

| Script | Requirement |
|---|---|
| `pnpm smoke:claude` | Claude CLI installed and authenticated |
| `pnpm smoke:codex` | Codex CLI installed and authenticated |
| Docker smokes | Docker daemon running |

### CLI wrapper scripts

The `scripts/smoke/mcp-*.mjs` files are secondary entry points that delegate to the same shared TypeScript implementations used by the Vitest tests. Prefer `pnpm smoke:*` / `pnpm test:*` for day-to-day use. If you invoke the wrappers directly, they require tsx:

```bash
node --import tsx/esm scripts/smoke/mcp-smoke.mjs
node --import tsx/esm scripts/smoke/mcp-e2e-checkpoint.mjs
node --import tsx/esm scripts/smoke/mcp-packed-tarball-smoke.mjs
node --import tsx/esm scripts/smoke/mcp-codex-config-smoke.mjs
```

### MCP Smoke Coverage Registry

`src/server/mcp/mcp-smoke-coverage.ts` is the authoritative static registry. `ALL_REGISTERED_TOOLS` lists every registered MCP tool and is compared against a real server's `tools/list`; the other lists partition it into three categories:

| Category | Description |
|---|---|
| `COVERED_TOOLS` | Called in `smoke:e2e` success path; MCP SDK validates `structuredContent` against `outputSchema` at runtime |
| `UNIT_ONLY_TOOLS` | Unit tests cover `outputSchema`; offline smoke call not needed |
| `DEFERRED_TOOLS` | Cannot be called in offline smoke; each entry must carry `reason` + `unblock` fields |

`UI_LINKED_TOOLS` is a separate axis, not a fourth category: it marks the tools whose registration carries the MCP Apps `_meta.ui.resourceUri` link, and each of them also belongs to exactly one category above.

Both `UNIT_ONLY_TOOLS` and `DEFERRED_TOOLS` are currently empty — every registered tool is exercised end-to-end in `smoke:e2e` (`COVERED_TOOLS`). Read the current lists from the file rather than from here.

`src/server/mcp/tool-structured-content.property.test.ts` enforces classification invariants as a meta-property test (runs with `pnpm test --project mcp-node`). `mcp-e2e-checkpoint.smoke-impl.ts` enforces a SET equality guard between `tools/list` runtime results and `ALL_REGISTERED_TOOLS`.

**Adding a new MCP tool**: Update `mcp-smoke-coverage.ts` first. If you skip this step, both the meta-property test and the smoke SET guard fail.

### MCP tool-surface scoreboards (ADR-0031)

Two pinned scoreboards judge the MCP tool table itself, beside the smoke that
proves each tool works:

| Instrument | Runs | Measures |
|---|---|---|
| `src/server/mcp/tool-surface-quality.test.ts` | `pnpm test --project mcp-node` | Per tool, off a real `tools/list`: model-visible bytes (name + description + input schema), wire bytes, description words, parameters and how many are undescribed, whether a stray key is refused or stripped, which neighbours the description names — plus the totals and that every schema-invalid call is a tool error. Pinned exactly; a change re-pins its row and says why. |
| `src/server/mcp/tool-call-count-quality.test.ts` | `pnpm test --project mcp-node` | Calls and request/response bytes per errand in `shared/test-utils/mcp-errand-corpus.ts`. |
| `pnpm --filter @kamiazya/whiteboard-mcp eval:tool-surface` | on demand, needs the `claude` CLI and API quota; skips cleanly without | A real model given only this server's tools, from an empty directory, on a seeded fixture (`packages/mcp-server/scripts/eval/fixture.mjs`), one task at a time (`packages/mcp-server/scripts/eval/tasks.mjs`). Graded by outcome — the answer string or the state read back — with calls, tools used, tool errors, tokens, cost and pass@k / pass^k over `--trials`. `--dry-run` seeds and checks the verifiers with no model call. |

The oracle for the first lives in `src/shared/test-utils/tool-surface-metrics.ts`
and never imports the registration code, so the surface cannot grade itself.
Run the third before and after any change to a tool's name, description, schema
or existence, and put both readings in the PR.

The third also scores every board a write task names with canvas-render's
drawing score (`packages/canvas-render/src/quality/drawing-score.ts`, pinned
over hand-drawn references and drafts in `drawing-quality.test.ts`), so a
drawing the verifier accepts and a reader would not is a non-zero debt column
on the run's line rather than something only the rendered SVG could show.

---

## Hosted Web App (Cloudflare Pages) Release Gates

`apps/web` (`@kamiazya/whiteboard-web`) is the zero-install browser-only app deployed to Cloudflare Pages. Its release-readiness is enforced by a mix of `web-browser` regressions, node/jsdom policy tests, and artifact smokes. Deploy/runtime contract details live in [deployment/cloudflare-pages.md](deployment/cloudflare-pages.md).

| Gate | Command | What it enforces | Build / browser needed |
|---|---|---|---|
| Artifact smoke | `pnpm --filter @kamiazya/whiteboard-web smoke:artifact` | `dist/index.html` + `dist/_headers` exist; CSP has no wildcard sources; no `unpkg.com` references anywhere in `dist/` (loro-crdt's WASM ships a `sourceMappingURL` custom section pointing at unpkg.com, stripped at build time — see `vite-plugin-strip-wasm-sourcemap.ts`); no Cloudflare secrets in any artifact; preview-origin rejection wired into the JS bundle | `pnpm build` first (reads `apps/web/dist/`) |
| Preview-origin smoke | `pnpm --filter @kamiazya/whiteboard-web smoke:preview-origin` | Built `dist/` loaded in real Chromium with a preview `publicOrigin` renders `data-provider="invalid-config"`, not the browser keeper | Build + Playwright |
| PWA precache gate | `pnpm --filter @kamiazya/whiteboard-web smoke:pwa-precache` | The generated `dist/sw.js` precache manifest names the entry chunk, the vendored Roboto face, the app icons and the Loro WASM module, read from the built artifact rather than from the Workbox config | `pnpm build` first (reads `apps/web/dist/`) |
| Bundle-size gate | `pnpm --filter @kamiazya/whiteboard-web smoke:bundle-size` | Gzipped budgets on the built `dist/`: the entry chunk, the stylesheet and the daemon page's lazy chunk each have a ceiling, and the critical path (the entry plus every chunk `index.html` modulepreloads) has its own regression stop | `pnpm build` first (reads `apps/web/dist/`) |
| LCP floor | `pnpm --filter @kamiazya/whiteboard-web smoke:lcp-floor` | Median Largest Contentful Paint of the built shell over five runs, under CDP-emulated CPU and network throttling, stays under 1000 ms. An absolute floor that refuses a serious accident, not a regression stop (the bundle-size gate is that) | Build + Playwright |
| PWA update-lifecycle smoke | `pnpm --filter @kamiazya/whiteboard-web smoke:pwa-lifecycle` | Built `dist/` served to real Chromium and one service worker walked through install, control, a waiting update the user accepts through the update toast, and the error screen's recovery (`reloadFresh` leaves no registration and no cache). `dist/` is never modified: the script's server appends a version handler to `/sw.js` to simulate a deploy. The mocks in `register-sw.test.ts` and `reload-fresh.test.ts` cannot notice a build whose worker behaves differently | Build + Playwright |
| Cross-origin transfer smoke | `pnpm smoke:transfer` | The browser app at one origin sends its workspace to a real server-mode keeper at another, behind a TLS-terminating proxy and a signed-in OIDC person: signed out the window shows the sign-in notice and merges nothing; signed in, Accept merges and the keeper's own API lists the document. Only this sees the keeper's real headers (a `same-origin` COOP would sever the popup's opener) | `pnpm build` first (web and mcp-server `dist/`) + Playwright |
| Browser-only regression | `pnpm test:browser` (`web-browser` project) | `BrowserDocumentPage.browser.test.tsx`: IndexedDB save / reload / cleanup / post-cleanup-reload, plus the network-negative gate (no `/api/*` or daemon fetch during editing) | Real browser (Playwright) |
| Origin policy | `pnpm --filter @kamiazya/whiteboard-web test` (`pages-origin-policy.test.ts`, `headers-policy.test.ts`) | `classifyPagesOrigin` keeps preview origins a distinct rejected class — a preview origin is never `production`, so it never enters a trusted/local-daemon allowlist; `_headers` CSP shape | jsdom only |
| Boundary + secrets drift | `pnpm test` (`web-app-boundary.test.ts`, `arch-lint-node`) | `apps/web` source imports no server/cli/daemon/Node-only modules; `wrangler.toml` lists no preview origins and no `account_id`; only the allowlisted workflows (`release.yml`, `deploy-preview.yml`, `preview-pr-deploy.yml`) hold the Cloudflare deploy secrets for `apps/web`; `apps/` stays out of the npm tarball | none |

`web-app-boundary.test.ts` and the `web-browser` regression run as part of `pnpm test`. The `smoke:*` gates in this table that read `dist/` require a build, so they are **not** part of the default `pnpm test`.

### `check:pages-release` (orchestrated by `@whiteboard/checks`)

One stable root command runs the build + both artifact smokes. It delegates to the private `@whiteboard/checks` tooling package (`tools/checks`), which prints each step, runs it from the repo root, and fails fast with the failing step's exit code:

```bash
pnpm check:pages-release
# → pnpm --filter @whiteboard/checks pages-release, which runs in order:
#     1. pnpm build
#     2. pnpm --filter @kamiazya/whiteboard-web smoke:artifact
#     3. pnpm --filter @kamiazya/whiteboard-web smoke:preview-origin
```

The layering is **root command → `@whiteboard/checks` orchestrator → package-local primitives**: the `apps/web smoke:*` scripts stay as low-level primitives, and `@whiteboard/checks` only orchestrates them. The runner is **matrix-driven** — it reads the `pages-release` tier from [`release-gate-matrix.json`](../../tests/e2e/distribution/release-gate-matrix.json), which stays the single policy source (add a Pages gate there, not in runner code). The wiring (root delegation, the private package, the matrix-driven runner) is enforced by the `pages-release tier wiring drift` block in `release-gate-matrix.test.ts`.

It is **release-candidate adjacent**: deliberately kept out of `check:release-candidate` and `check:release-candidate:docker`/`:local`, because `smoke:preview-origin` needs Playwright and a local `127.0.0.1` HTTP bind (it fails with `EPERM` in a network-restricted sandbox; runs green in a normal environment). The orchestrating command is not a CI step, but the CI `verify` job runs the same primitives (`smoke:artifact`, `smoke:bundle-size`, `smoke:pwa-precache`, `smoke:lcp-floor`, `smoke:preview-origin`, `smoke:pwa-lifecycle`, and the root `smoke:transfer`) on every PR; run `check:pages-release` before a Cloudflare Pages deploy.

### Security review map

Which gate enforces each hosted-app security property (entry points for `security-reviewer`):

| Property | Enforced by |
|---|---|
| CSP has no wildcard sources; `script-src`/`default-src` are `'self'` | `smoke:artifact` (CSP directive checks) + `headers-policy.test.ts` |
| No Cloudflare secrets / account IDs in the built artifact | `smoke:artifact` (secret scan over `dist/`) |
| No Cloudflare secrets in `apps/web` config or `.github/workflows/` | `web-app-boundary.test.ts` (CF secrets drift guard) |
| Preview origin is rejected at runtime (renders `invalid-config`) | `smoke:preview-origin` (behavioral) + bundle wiring check in `smoke:artifact` |
| Production origin is an exact match (`https://kamiazya-whiteboard.pages.dev`), preview is a distinct class | `pages-origin-policy.test.ts` (`classifyPagesOrigin`) |
| Preview origin never enters a trusted / local-daemon allowlist | `pages-origin-policy.test.ts` (preview ≠ production) + `web-app-boundary.test.ts` (no preview origin in `wrangler.toml`); server-mode wildcard rejection is held separately by `server-mode-exposure` |

---

## Quality Gates

Common commands are also summarized in [CONTRIBUTING.md](../../CONTRIBUTING.md#pull-request-checklist). This section is the canonical gate matrix.

```bash
pnpm lint           # Biome — must be green before review
pnpm typecheck      # TypeScript — must be green before review
pnpm test           # optional: every project at once, CI runs the matrix; full suite (see root vitest.config.ts): mcp-node, mcp-smoke, daemon-client node, model node, ports node, facet-engine node, facet-ui jsdom, plugin-visual node/jsdom, codec node, loro-adapter node, search node, reference-graph node, server-core node, workspace-index node, history node, scene node, extension node, arch-lint-node, canvas-render node/browser, canvas-viewer node/jsdom/browser, apps/web node/jsdom/browser/browser-window-state
pnpm test:browser   # canvas-viewer-browser + web-browser + canvas-render-browser + web-browser-window-state (the real-browser projects)
pnpm smoke:e2e      # stdio MCP smoke (also covered by pnpm test via mcp-smoke)
pnpm coverage       # every non-browser project with v8 coverage -> tmp/coverage/lcov.info
```

`pnpm coverage` is what the SonarQube Cloud lane runs; locally it is a way to see which
modules have no test loading them at all. It is not a gate — no threshold fails it, and
the browser projects are not measured (their v8 coverage is charged to a page rather than
to the module graph). Coverage options are configured in the ROOT `vitest.config.ts` only:
with `projects`, a per-project `coverage` block is ignored, and the `include` globs are
resolved against each project's OWN root, so they are written `**/src/**`, never
`packages/*/src/**`.

### SonarQube's coverage verdict does not apply to a UI change

The browser projects are not measured, so a change under `apps/web/src/components/**` or
`apps/web/src/pages/**` shows a LOW "Coverage on New Code" however thoroughly a real browser
covers it. Measured on the first one to hit it: a `DocumentPage` change with 113 passing
`web-browser` tests over the very panels it touched reported 68.4% against the gate's 80%.

**Read the rest of the analysis and ignore that one condition on such a PR** (user decision,
2026-09-20). The lane is report-only, so nothing is blocked; what this note exists to stop is
the next reader treating the number as a statement about the tests.

The two alternatives were considered and rejected. Excluding `components/**` and `pages/**`
from `sonar.coverage.exclusions` would say "not measured" honestly but give up the metric
permanently and be awkward to undo. Measuring the browser projects needs Playwright and a real
Chrome in the coverage job, costs CI time, and charges v8's counts to a page rather than to the
module graph — which is the reason they are left out in the first place.

**Additional gates by change type:**

| Change type | Required gate |
|---|---|
| Contract / persistence / security / state-machine / race | Add or update nearest property/model/race test |
| MCP tool or route change | `pnpm smoke:e2e` green; real MCP client verify |
| Browser interaction or UI flow | `pnpm test:browser` green; manual browser verify |
| Packaging, tarball, or binary | `pnpm test:distribution` green, and `pnpm smoke:distribution:packaged:node` (the packaged-daemon and server-mode smokes CI's `packaged-smoke` job runs on every PR; it needs a build and, unlike `smoke:distribution:packaged`, spends no CLI API quota) |
| Hosted web app / Cloudflare Pages artifact | `pnpm check:pages-release` (build + `smoke:artifact` + `smoke:preview-origin`); release-candidate adjacent, see [Hosted Web App Release Gates](#hosted-web-app-cloudflare-pages-release-gates) |
| Typing or packaging impact | `pnpm --filter @kamiazya/whiteboard-mcp typecheck && pnpm build` |
| Behavioral production change inside Stryker target set | Run `pnpm mutation:contracts`; report killed/survived in PR body |
| Deferred property | Record reason + unblock condition in a whiteboard `type: issue` document (`ticketing` skill) or planning note |

---

## Agent Notes

The following rules apply specifically when an AI coding agent executes the workflow.

**Test-first discipline:**

- Do not implement first and add tests later.
- Keep the first failing case as small and local as possible.
- Do not rely on jsdom alone for browser interaction bugs.

**Manual verification:**

- After each code change, manually verify the real behavior — not just the test output.
- If the changed flow is represented by a project skill under `./skills/*`, read the relevant `SKILL.md` and dogfood the real MCP/skill flow instead of verifying through mocks only.
- Record every still-open dogfooding finding as a whiteboard document of `type: issue` (see the `ticketing` skill). When it is fixed, change it to `type: note` with a `RESOLVED — ` name prefix rather than deleting it.
- If runtime behavior disagrees with the test, treat runtime as the source of truth and fix the test or implementation.

**Mutation testing:**

- Prefer `pnpm mutation:contracts` over manually editing production code when the touched code is in the mutation target set. Stryker isolates mutated variants and avoids leaving accidental dirty source changes behind.
- Manual mutation checks remain acceptable for surfaces outside Stryker coverage (UI flows, browser-only behavior, E2E-only composition). Keep them narrow, restore the source immediately, and check the working tree before finishing.
- Do not change production parsing or guard logic based solely on a surviving mutant without first confirming it is a real risk (see Survivor classification above).

**Stryker infrastructure:**

- `vitest.stryker.config.ts` exists solely for the Stryker dry run. It excludes tests that fail under Stryker's worker isolation (`vi.spyOn(process.stderr, 'write')`) or have pre-existing failures on the current branch. These exclusions do not reduce regular `mcp-node` coverage — verify by running `pnpm test --project mcp-node`.
- Before adding a new exclusion to `vitest.stryker.config.ts`, confirm the test passes in the normal suite and document the specific incompatibility reason.

**Do not:**

- Skip manual verification.
- Keep debug-only code in the final patch.
- Add broad E2E coverage before checking whether a smaller test can isolate the root cause.
- Mark a deferred property as complete just because the code path is not ready.
