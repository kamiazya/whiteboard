# Upgrading vitest (runbook)

Only what is specific to MOVING versions lives here: which breaking changes touch this tree,
and in what order to land the move. What each new feature does, with its API, lives beside
the situation it serves — search the other resources for the `[v5]` tag (a heading that
needs Vitest ≥ 5) rather than here, because a reader who does not already know a feature
exists never opens a file named after a version.

Current: **4.1.10** (`pnpm-workspace.yaml` catalog, with `@vitest/browser-playwright` and
`@vitest/coverage-v8` pinned alongside). Vitest 5 (2026-09-03) requires Vite ≥ 6.4 and
Node ≥ 22.12; the catalog holds Vite 8.2 and `.node-version` pins 24. Migration guide:
`vitest.dev/guide/migration`. Update the "Hits" column and the order below as slices land,
and delete the `[v5]` tags from the other resources when the catalog is on 5.

## Breaking changes against this tree

Measured 2026-09-05 by grep over `*.test.ts(x)`, `vitest*.ts` and `*.bench.ts`.

| Change | Hits | Action | Where the feature is described |
|---|---|---|---|
| module-scope `bench` import removed | 3 files (`canvas-render/src/layout/**/*.bench.ts`) | rewrite to the context fixture; re-derive `measured-change`'s `run()` from the new reporter output | `configuration.md` › Benchmarks |
| `toHaveTextContent(RegExp)` | 2 (`CommentsPanel.browser.test.tsx`) | `toMatchTextContent` | `browser-mode.md` › Strict locators |
| locators strict by default | ~1389 `getBy*` sites to re-read | accept strictness; `locators.exact: false` only as a stated, temporary opt-out | `browser-mode.md` › Strict locators |
| un-awaited `.resolves` / `.rejects` / `toMatchFileSnapshot` fail | 0 (lint rule) | — | `async-and-timers.md` |
| `expect.poll` rejects on timeout | 14 sites | re-run; any that relied on a late pass surfaces | `async-and-timers.md` |
| `clearMocks` default `true` | pre-adopt on v4 | slice 1 | `isolation-and-state.md` › Mocks |
| nested `vi.mock` throws | 0 | — | `isolation-and-state.md` |
| `test.sequential` / `sequential:` removed | 0 (`mcp-smoke` uses `maxWorkers: 1`) | — | — |
| `VITEST_POOL_ID` / `VITEST_WORKER_ID` 1-based | 0 | — | `configuration.md` |
| `Assertion<T>` → `Assertion<R, T>` | 0 custom matchers | — | `configuration.md` › Custom matchers |
| `extends`, `sharedViteServer`, nested `projects` | 0 inline projects | **do not nest** until `vitest-projects.mjs` understands it | `configuration.md` › Projects |
| `browser.api` → `api` | 0 | — | `configuration.md` |
| removed entrypoints (`vitest/coverage`, `/reporters`, `/environments`, `/snapshot`) | 0 | — | — |
| `testNamePattern` full chain | no `-t` in scripts or CI | — | `configuration.md` |
| `toThrow('')` matches any error | 0 | — | `configuration.md` |
| artifacts under `.vitest/` | `.gitignore:164` | replace `.vitest-attachments/` with `.vitest/`; re-measure the 155-char title budget | `configuration.md` › Artifacts |
| `Temporal` under fake timers | unchecked | grep at upgrade | `async-and-timers.md` |
| `populateGlobal` descriptors, `resolveConfig` return shape | unchecked (`tools/`) | grep at upgrade | — |
| config files no longer found in parent dirs | every project has its own | — | — |

## Order

Each slice is its own PR so its CI run answers one question.

1. **`clearMocks: true` on the v4 configs** (`packages/mcp-server/vitest.shared.ts`,
   `apps/web/vitest.config.ts`, `vitest.browser.shared.ts`, the per-package node configs).
   A failure is an order-dependent test; fix it as such.
2. **Bench rewrite** (3 files) + the `measured-change` recipe. Same slice as 3 if the v5
   context fixture is not available on v4.
3. **The bump**: catalog to `^5` for `vitest`, `@vitest/browser-playwright`,
   `@vitest/coverage-v8`; `.gitignore`; `toMatchTextContent`; `vitest doctor` output in the
   PR; then the locator-strictness fallout.
4. **Measure the two hypotheses** before adopting either: `browser.traceView` size on
   `apps/web`'s 16 page files against the 302MB / 7.5MB baseline, and collection cost with
   `fsModuleCache` via the duration breakdown, both on a quiet tree. Rewrite
   `browser-mode.md`'s Traces section and `vitest.browser.shared.ts`'s header from the
   numbers.
5. **`--repeats`** beside the fresh-process loop in `stress-changed-tests`;
   `--browser.traceView` + `['html', { singleFile: true }]` as an uploaded artifact in the
   browser CI job if 4 backed it.
6. Re-measure the browser title budget with `browser-test-name-length.test.ts`'s
   forced-failure recipe; re-pin or retire it. Delete the `[v5]` tags.
