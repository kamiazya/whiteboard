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
4. Lock the verified flow into `web-browser` or E2E coverage.

Skip step 3 only for pure helper changes with no observable runtime effect. Skip step 4 only when the verified scenario is already covered by an existing automation.

---

## Standard Workflow

```bash
# 1. Run the narrowest project first
pnpm test --project mcp-node
pnpm --filter @kamiazya/whiteboard-web test   # apps/web jsdom, when the change touches UI

# 2. After targeted test passes, run the broader gate for the touched area
pnpm test
pnpm test:browser        # for browser-mode changes (canvas-viewer-browser + apps/web web-browser)
pnpm smoke:e2e           # for MCP tool / route / protocol changes
pnpm test:e2e:distribution # for packaged daemon / tarball / binary behavior
```

---

## Test Layer Selection

Choose the **narrowest** layer that can prove the behavior:

| Layer | Config | When to use |
|---|---|---|
| `mcp-node` | `vitest.node.config.ts` (`packages/mcp-server`) | Pure functions, stores, routes, server behavior, persistence logic, schemas, CLI helpers |
| apps/web jsdom | `apps/web/vitest.config.ts` | React components and hooks when real layout, focus, pointer, or browser APIs are **not** the core risk |
| `web-browser` | `apps/web/vitest.browser.config.ts` | `apps/web` tests that need real browser APIs unavailable in jsdom: IndexedDB, OPFS, `window.showOpenFilePicker`, popovers/dialogs/focus/scroll/restore flows, and other platform APIs. File suffix: `.browser.test.tsx` |
| E2E | `tests/e2e/` | Real routes, server composition, websocket timing, daemon process lifecycle, persistence order, packaging, or multi-step product journeys |

The UI lives solely in `apps/web` since the MCP-UI retirement (ADR 0001); `packages/mcp-server` is backend-only and has no jsdom/browser layer of its own.

**Promotion rules:**

- Do not jump to broad E2E first if a smaller failing test can isolate the bug.
- When an E2E catches a bug, add the nearest-layer test as well unless the root cause only exists at the composed-system boundary.
- Prefer `web-browser` over apps/web jsdom whenever the scenario involves focus, pointer, dialog, popover, scroll, or restore behavior.

---

## Property-Based Testing

Use PBT when the behavior is better described as an invariant over many inputs than as one fixed example.

**Prefer PBT for:**

- Process-boundary contracts: MCP tool schemas, HTTP response schemas, persisted JSON parsers
- Security boundaries: auth routing, Origin/CORS policy, path confinement, token redaction
- Migration and compatibility logic: old/new versions, malformed payloads, unknown fields
- State machines: browser-local controller, daemon lifecycle, branch/head/version state
- Concurrency and race risks: save/export/import ordering, late failures, retry/reload behavior

**File naming:**

- `*.property.test.ts` — invariant tests over generated inputs
- `*.model.test.ts` / `*.model.test.tsx` — model-based state-machine tests
- `*.race.test.ts` / `*.race.test.tsx` — scheduler or ordering tests

**Shared utilities:**

- Use `src/shared/test-utils/fast-check.ts` instead of importing `fast-check` directly.
- Shared arbitraries belong under `src/shared/test-utils/arbitraries/` when they model a shared contract.
- Shared model helpers belong under `src/shared/test-utils/models/` when multiple tests share the same state vocabulary.

**Replayability:** Avoid `Math.random()`, wall-clock timing, real network, and unseeded global state inside generated runs.

### Property catalog

The canonical catalog of property IDs lives in `tmp/notes/2026-05-06-property-catalog.md` (`P-<DOMAIN>-NNN` format).

Operational rules:

- When you add a PBT, leave the matching property ID in a test name or comment so `property-catalog-coverage.test.ts` can pair them up. New IDs that are neither covered nor explicitly deferred fail CI.
- Deferred properties must declare a concrete `reason` (e.g. "no contract yet", "requires HTTPS") and an `unblock` condition in `DEFERRED_PROPERTIES`. "Not implemented yet" alone is not a valid reason — always point at the blocker.
- The default `pnpm test` keeps `numRuns` low for CI speed. Run `pnpm test:pbt:stress` (sets `PBT_STRESS=1`) for deeper exploration before a release. Race / model tests can request an extra multiplier via `withDefaults(overrides, { stressMultiplier: N })`.
- Property IDs cited in tests, comments, or smoke must exist in the catalog. The phantom-reference check fails on typos and on stale references to removed catalog entries.
- When fast-check reports a counterexample, paste the seed / path output into the PR body or `tmp/issues/` note so the failure can be replayed deterministically.
- The deferred-property table has a hard ceiling (`MAX_DEFERRED_PROPERTIES`). Bumping it is a deliberate review decision — every increase ships with the new entry's `reason`/`unblock` and a brief justification in the PR body.

---

## Mutation Testing

Use [StrykerJS](https://stryker-mutator.io/) for mutation testing on the configured target set.

```bash
pnpm mutation:contracts
```

This runs Stryker with `packages/mcp-server/stryker.config.mjs`, which uses a dedicated Vitest config (`vitest.stryker.config.ts`) to keep the dry run stable. **Do not use `vitest.stryker.config.ts` for normal test runs or CI** — use `vitest.node.config.ts` instead.

### Purpose and scope

Mutation testing checks whether the current test suite notices plausible implementation changes. It is a complement to example tests and PBT, not a replacement.

Keep Stryker scope **narrow**:

- Intended for contract/helper surfaces: schemas, parsers, diagnostics redaction, path guards, small pure helpers.
- Do **not** expand runs to browser-mode, Playwright E2E, Excalidraw rendering, daemon lifecycle smokes, or broad React interaction flows unless a dedicated Stryker target is added for that surface.

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

If a surviving mutant reveals a gap but the production fix is out of scope for the current PR, record it in `tmp/issues/` and address it separately.

### Current mutation target set

The following files are covered by `pnpm mutation:contracts`. This list must stay in sync with `packages/mcp-server/stryker.config.mjs`.

```
src/shared/diagnostics/redact.ts
src/server/store/path-guard.ts
src/server/output-path.ts
src/shared/api-contracts/libraries.ts
src/shared/api-contracts/daemon-doctor.ts
src/shared/api-contracts/runtime.ts
src/server/security/server-mode-env-config.ts
src/server/security/server-mode-auth-plan.ts
src/server/security/server-mode-exposure.ts
src/server/security/server-mode-record.ts
src/server/routes/canvas-thumbnail.ts
src/server/routes/canvas-output-path-error.ts
```

---

## Browser Testing

There are two real-browser Vitest projects:

| Project | Package | Purpose |
|---|---|---|
| `canvas-viewer-browser` | `packages/canvas-viewer` | Popovers, dialogs, scroll, focus, keyboard, pointer, and restore flows where browser layout and pointer behavior are the core risk |
| `web-browser` | `apps/web` | `apps/web` app browser regressions: popovers, dialogs, focus, keyboard, restore flows, and tests requiring real browser APIs unavailable in jsdom (IndexedDB, OPFS, `window.showOpenFilePicker`) |

```bash
pnpm run test:browser         # canvas-viewer-browser + web-browser
pnpm run test:browser:trace   # same, with trace artifacts on failure
```

**jsdom exclude policy**: apps/web's jsdom config must exclude `.browser.test.ts` and `.browser.test.tsx` files. Tests that depend on IndexedDB or other real browser APIs belong in `web-browser`, not jsdom. Mixing them causes silent no-op failures or missing-API errors.

Failure traces are stored under `<package>/tmp/vitest-traces` — `packages/canvas-viewer/tmp/vitest-traces` for `canvas-viewer-browser`, `apps/web/tmp/vitest-traces` for `web-browser`. Check traces before adding temporary debug code. Remove temporary debug overlays and instrumentation before finishing.

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

- Real routes, server middleware, websocket timing, daemon startup/shutdown, and persistence order
- Browser-local to local-daemon migration journeys
- Packaged CLI, tarball, binary, and install-layout behavior
- MCP protocol smoke flows that must validate the real server entrypoint
- User journeys where mocks would hide routing, runtime config injection, or process-boundary behavior

**Do not use E2E** for pure parsing, schema validation, isolated store logic, or component state testable in `mcp-node`, apps/web jsdom, or `web-browser`.

**E2E placement:**

- `tests/e2e/browser/` — Playwright browser journeys against real app/server surfaces
- `tests/e2e/mcp/` — MCP protocol and client/server smoke behavior
- `tests/e2e/distribution/` — packaged daemon, tarball, binary, and install-layout checks

Keep E2E suites small and focused. If E2E finds a bug, add the nearest-layer regression unless the root cause only exists at the composed-system boundary.

---

## Smoke & Distribution Tests

MCP startup, protocol, and distribution-artifact smokes run as Vitest projects. The shared implementations under `src/server/mcp/*.smoke-impl.ts` and `*.distribution-impl.ts` are used by both the Vitest tests and the `scripts/smoke/mcp-*.mjs` CLI wrappers.

### `mcp-smoke` — included in `pnpm test`

Runs alongside `mcp-node` during normal `pnpm test`. No build prerequisite. Tests run sequentially to avoid daemon port conflicts.

| Script | What it covers |
|---|---|
| `pnpm smoke` | Startup-only: MCP server starts without fatal errors and stays alive for 3 s |
| `pnpm smoke:e2e` / `pnpm smoke:checkpoint` | Full stdio MCP round-trip: canvas create → annotate → checkpoint → restore → export |
| `pnpm smoke:template` | Template tool render and content checks |

Run all mcp-smoke tests together:

```bash
pnpm --filter @kamiazya/whiteboard-mcp test:smoke    # vitest run --project mcp-smoke
```

### `mcp-distribution` — opt-in, requires build

Not included in `pnpm test`. Requires `dist/server/mcp/index.js` to exist. `test:distribution` includes the build step; individual `smoke:*` scripts do not (CI builds before calling them). Tests run sequentially to avoid daemon port conflicts.

| Script | What it covers | Build included |
|---|---|---|
| `pnpm smoke:packaged` | Packaged `dist/server/mcp/index.js` passes full e2e checkpoint flow | No |
| `pnpm smoke:tarball` | `npm pack` → install → installed entry passes full e2e checkpoint flow | No |
| `pnpm smoke:codex-config` | Plugin manifest + published MCP config valid; packaged entry starts | No |
| `pnpm test:distribution` | All three above, after `pnpm build` | Yes |

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
tsx scripts/smoke/mcp-template-smoke.mjs
```

### MCP Smoke Coverage Registry

`src/server/mcp/mcp-smoke-coverage.ts` is the authoritative static registry that classifies all 48 registered MCP tools into four categories:

| Category | Description |
|---|---|
| `COVERED_TOOLS` | Called in `smoke:e2e` success path; MCP SDK validates `structuredContent` against `outputSchema` at runtime |
| `ERROR_PATH_ONLY_TOOLS` | Route wiring verified via error path only (`viewport_set` — requires a browser client for the success path) |
| `UNIT_ONLY_TOOLS` | Unit tests cover `outputSchema`; offline smoke call not needed |
| `DEFERRED_TOOLS` | Cannot be called in offline smoke; each entry must carry `reason` + `unblock` fields |

`src/server/mcp/tool-structured-content.property.test.ts` enforces classification invariants as a meta-property test (runs with `pnpm test --project mcp-node`). `mcp-e2e-checkpoint.smoke-impl.ts` enforces a SET equality guard between `tools/list` runtime results and `ALL_REGISTERED_TOOLS`.

**Adding a new MCP tool**: Update `mcp-smoke-coverage.ts` first. If you skip this step, both the meta-property test and the smoke SET guard fail.

**`library_install` — explicitly DEFERRED**

`library_install.execute()` calls `fetchExternalLibraryPayload()` via global `fetch`. Additionally, `validateExternalUrl()` rejects localhost and private-range IPs before the fetch fires, so a plain `node:http.createServer` stub is insufficient. Unblocking requires nock/MSW fetch interception or a testable lookup injection seam in production code.

---

## Hosted Web App (Cloudflare Pages) Release Gates

`apps/web` (`@kamiazya/whiteboard-web`) is the zero-install browser-only app deployed to Cloudflare Pages. Its release-readiness is enforced by a mix of `web-browser` regressions, node/jsdom policy tests, and artifact smokes. Deploy/runtime contract details live in [deployment/cloudflare-pages.md](deployment/cloudflare-pages.md).

| Gate | Command | What it enforces | Build / browser needed |
|---|---|---|---|
| Artifact smoke | `pnpm --filter @kamiazya/whiteboard-web smoke:artifact` | `dist/index.html` + `dist/_headers` exist; CSP has no wildcard sources; no Cloudflare secrets in any artifact; preview-origin rejection wired into the JS bundle | `pnpm build` first (reads `apps/web/dist/`) |
| Preview-origin smoke | `pnpm --filter @kamiazya/whiteboard-web smoke:preview-origin` | Built `dist/` loaded in real Chromium with a preview `publicOrigin` renders `data-provider="invalid-config"`, not browser-local | Build + Playwright |
| Browser-only regression | `pnpm test:browser` (`web-browser` project) | `BrowserLocalCanvasPage.browser.test.tsx`: IndexedDB save / reload / cleanup / post-cleanup-reload, plus the network-negative gate (no `/api/*` or daemon fetch during editing) | Real browser (Playwright) |
| Origin policy | `pnpm --filter @kamiazya/whiteboard-web test` (`pages-origin-policy.test.ts`, `headers-policy.test.ts`) | `classifyPagesOrigin` keeps preview origins a distinct rejected class — a preview origin is never `production`, so it never enters a trusted/local-daemon allowlist; `_headers` CSP shape | jsdom only |
| Boundary + secrets drift | `pnpm test` (`web-app-boundary.test.ts`, `mcp-node`) | `apps/web` source imports no server/cli/daemon/Node-only modules; `wrangler.toml` lists no preview origins and no `account_id`; no `.github/workflows/` file deploys `apps/web` with Cloudflare secrets; `apps/` stays out of the npm tarball | none |

`web-app-boundary.test.ts` and the `web-browser` regression run as part of `pnpm test`. The two `smoke:*` artifact gates require a build, so they are **not** part of the default `pnpm test`.

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

It is **release-candidate adjacent**: deliberately kept out of `check:release-candidate`, `check:release-candidate:docker`/`:local`, and the CI `verify` job, because `smoke:preview-origin` needs Playwright and a local `127.0.0.1` HTTP bind (it fails with `EPERM` in a network-restricted sandbox; runs green in a normal environment). Run it before a Cloudflare Pages deploy, not on every PR.

### Security review map

Which gate enforces each hosted-app security property (entry points for `security-reviewer`):

| Property | Enforced by |
|---|---|
| CSP has no wildcard sources; `script-src`/`default-src` are `'self'` | `smoke:artifact` (CSP directive checks) + `headers-policy.test.ts` |
| No Cloudflare secrets / account IDs in the built artifact | `smoke:artifact` (secret scan over `dist/`) |
| No Cloudflare secrets in `apps/web` config or `.github/workflows/` | `web-app-boundary.test.ts` (CF secrets drift guard) |
| Preview origin is rejected at runtime (renders `invalid-config`) | `smoke:preview-origin` (behavioral) + bundle wiring check in `smoke:artifact` |
| Production origin is an exact match (`https://kamiazya-whiteboard.pages.dev`), preview is a distinct class | `pages-origin-policy.test.ts` (`classifyPagesOrigin`) |
| Preview origin never enters a trusted / local-daemon allowlist | `pages-origin-policy.test.ts` (preview ≠ production) + `web-app-boundary.test.ts` (no preview origin in `wrangler.toml`); local-daemon / server-mode wildcard rejection is held separately by `server-mode-exposure` |

---

## Quality Gates

Common commands are also summarized in [CONTRIBUTING.md](../../CONTRIBUTING.md#quality-gates). This section is the canonical gate matrix.

```bash
pnpm lint           # Biome — must be green before review
pnpm typecheck      # TypeScript — must be green before review
pnpm test           # full suite (see root vitest.config.ts): mcp-node, mcp-smoke, canvas-viewer node/jsdom/browser, apps/web node/jsdom/browser
pnpm test:browser   # canvas-viewer-browser + web-browser (the real-browser projects)
pnpm smoke:e2e      # stdio MCP smoke (also covered by pnpm test via mcp-smoke)
```

**Additional gates by change type:**

| Change type | Required gate |
|---|---|
| Contract / persistence / security / state-machine / race | Add or update nearest property/model/race test |
| MCP tool or route change | `pnpm smoke:e2e` green; real MCP client verify |
| Browser interaction or UI flow | `pnpm test:browser` green; manual browser verify |
| Packaging, tarball, or binary | `pnpm test:distribution` green |
| Hosted web app / Cloudflare Pages artifact | `pnpm check:pages-release` (build + `smoke:artifact` + `smoke:preview-origin`); release-candidate adjacent, see [Hosted Web App Release Gates](#hosted-web-app-cloudflare-pages-release-gates) |
| Typing or packaging impact | `pnpm --filter @kamiazya/whiteboard-mcp typecheck && pnpm build` |
| Behavioral production change inside Stryker target set | Run `pnpm mutation:contracts`; report killed/survived in PR body |
| Deferred property | Record reason + unblock condition in `tmp/issues/` or planning note |

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
- Record every still-open dogfooding finding as a small issue note under `./tmp/issues/`. Remove the note once the issue is fixed.
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
