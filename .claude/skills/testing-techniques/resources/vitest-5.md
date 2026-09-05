# Vitest 5, mapped to this repo's traps

Released 2026-09-03 (`vitest.dev/blog/vitest-5`). Requires Vite ≥ 6.4 and Node ≥ 22.12; the
catalog holds Vite 8.2 and `.node-version` pins 24, so both are met. This tree is on
**4.1.10** (`pnpm-workspace.yaml` catalog) — everything below is either *measured here* on
2026-09-05 or marked *verify at upgrade*. Update this file when the upgrade lands: the
"status" column is the point of it.

## Trap → feature

| Trap this repo has hit | Vitest 5 | Status |
|---|---|---|
| un-awaited `.resolves` checks nothing (warned only) | fails the test | lint rule added ahead of it; measured 0 occurrences |
| `expect.poll` passing on a late resolution | rejects on timeout; callback gets an `AbortSignal` | 14 call sites; *verify at upgrade* that none relied on the late pass |
| the default trace has no DOM view; snapshots cost 23GB/run | `browser.traceView` — DOM-snapshot replay, provider-independent, in UI + HTML reporter | *verify at upgrade*: size on `apps/web`'s 16 page files against the 302MB / 7.5MB baseline |
| `ENAMETOOLONG` in `.vitest-attachments/` drops the rest of a file | all artifacts under `.vitest/` (`.vitest/attachments/`) | *verify at upgrade*: re-run the forced-failure measurement in `browser-test-name-length.test.ts`; re-pin or retire the 155-char budget |
| a held `/title/i` bound to the outgoing page; `getByText('Item')` matching `Item 1` | locators strict by default (`locators.exact`), `toHaveTextContent` exact, `toMatchTextContent` for RegExp, `browser.locators.errorFormat: 'aria'` | ~1389 `getBy*` call sites; 2 RegExp `toHaveTextContent` (`CommentsPanel.browser.test.tsx`) |
| call history carried between tests | `clearMocks: true` by default | pre-adopt in v4 configs as its own slice |
| `vi.mock` nested in a block warned | throws | measured 0 |
| config `test.repeats` ignored in 4.1 (why the CI stress loop is a shell `for`) | `--repeats=N` repeats every test in-process | add beside the fresh-process loop, not instead of it (`stability-checks.md`) |
| a per-test timeout paying for module import | `fsModuleCache` persists transformed modules across runs and processes | *verify at upgrade* with the duration breakdown (`environment X%, import Y%…`) before and after |
| 22 projects, one root list, hand-tuned pool | `vitest doctor` recommends pool/isolation config from a real run | run once at upgrade, paste its output in the PR |
| `pnpm bench` output parsed by `grep | awk` (`measured-change`) | benchmarking rewritten: `bench` is a test-context fixture, `bench.compare`, `toBeFasterThan`, `writeResult` + `bench.from()` baselines; output in the default/json reporters | 3 files break: `packages/canvas-render/src/layout/{edges/spatial-edges,nodes/mdast-blocks,spatial-canvas}.bench.ts`; `measured-change`'s recipe changes |
| `--project` filter silently matching nothing | unchanged — still errors only on an EMPTY set | keep the count-floor habit; `-p` shorthand and hierarchy names (`app (unit)`) are new |

## Breaking changes checked against this tree

Measured 2026-09-05 with grep over `*.test.ts(x)`, `vitest*.ts` and `*.bench.ts`:

| Change | Hits | Action |
|---|---|---|
| top-level `bench` import removed | 3 files | rewrite to `test('…', async ({ bench }) => …)`; re-derive `measured-change`'s `run()` from the new reporter output |
| `toHaveTextContent(RegExp)` | 2 | → `toMatchTextContent` |
| `test.sequential` / `sequential:` removed | 0 | — (`mcp-smoke` sequences via `maxWorkers: 1`) |
| `VITEST_POOL_ID` / `VITEST_WORKER_ID` now 1-based | 0 | — |
| custom matchers (`Assertion<T>` → `Assertion<R, T>`) | 0 | — |
| `extends: true` / inline projects | 0 (all projects are file-referenced) | — |
| `browser.api` → top-level `api` | 0 | — |
| removed entrypoints (`vitest/coverage`, `/reporters`, `/environments`, `/snapshot`) | 0 | — |
| `testNamePattern` matches the full `suite > test` chain | no `-t` in scripts or CI | — |
| `toThrow('')` matches any error | 0 | — |
| `.vitest-attachments/` → `.vitest/` | `.gitignore` line 164 | replace with `.vitest/`; check `tmp/vitest-traces` still applies to Playwright's own trace |
| nested `projects` in a referenced config | — | **do not adopt** until `tools/checks/src/vitest-projects.mjs` (regex over the root config) and its three consumers understand nesting |
| `@vitest/browser-playwright`, `@vitest/coverage-v8` | catalog `^4.1.10` | bump together |

Un-checked (grep them at upgrade): `Temporal` under fake timers; `populateGlobal` in any
custom environment; `resolveConfig` callers in `tools/`.

## Upgrade order

Each slice is its own PR so its CI run answers one question.

1. **`clearMocks: true` in the shared v4 configs** (`packages/mcp-server/vitest.shared.ts`,
   `apps/web/vitest.config.ts`, `vitest.browser.shared.ts` and the per-package node configs).
   Any failure is an order-dependent test — fix it as such.
2. **Bench rewrite** (3 files) + `measured-change` recipe, on v4 if the new API is available
   there, else as the first slice of 3.
3. **The bump**: catalog to `^5`, `.gitignore`, `toMatchTextContent`, run `vitest doctor`,
   then the locator-strictness fallout (accept strictness; `browser.locators.exact: false`
   only as a stated, temporary opt-out).
4. **Measure the two hypotheses**: `traceView` size on the 16-file subset, and collection cost
   with `fsModuleCache` — using the duration breakdown, on a quiet tree, before and after.
   Adopt only what the numbers back; rewrite `browser-mode.md` and `vitest.browser.shared.ts`'s
   header from the measurement.
5. **`--repeats`** in `stress-changed-tests` beside the shell loop; `--browser.traceView` in
   the browser CI job with `['html', { singleFile: true }]` as an uploaded artifact if 4
   backed it.
6. Re-measure the title budget (`browser-test-name-length.test.ts`'s forced-failure recipe)
   and re-pin or retire it.

## Smaller wins to reach for once on 5

- `vi.when(...)` + `toHaveBeenExhausted` for any mock that branches on its arguments.
- `expect.poll(({ signal }) => fetch(url, { signal }))` wherever a poll wraps a request.
- `injectCjsGlobals: false` is a candidate for the shared-layer packages, whose sources must
  not read `__dirname` anyway (`architecture-map.md` rule 1) — a test that passed only because
  vitest injected it would then fail honestly.
- `TestCase.logs()` and `filterMeta` on the JSON reporter, if `flake-watch.mjs` ever wants
  more than the annotation title.
- `--merge-reports` now merges non-sharded runs across environments, which is the shape CI's
  split browser/jsdom jobs produce.
