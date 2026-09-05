# Running and configuring vitest in this repo

Projects, filters, pools, caches, artifacts, reporters, benchmarks and `expect` extensions,
as they are on the installed Vitest — the `vitest:` line of `pnpm-workspace.yaml`'s catalog
(5.0.0 since 2026-09-05). A config key the installed version does not know is IGNORED
silently, so an option from a newer release does nothing rather than failing; check the
version before relying on one.

## Projects and filters

- The root `vitest.config.ts` lists every project config file; each declares a `name:`
  (`tools/checks/src/vitest-projects.mjs` throws on one without, since CI derives the
  shared-layer step from the list). `vitest run --project <name>` runs one;
  `pnpm test:browser` runs the three browser projects.
- **A filter that matches nothing beside one that does is silent.** vitest errors only when
  the whole `--project` set is empty (`resources/isolation-and-state.md`). Match the local
  command to the CI job and treat a low count as a missed filter.

### `-p` shorthand and nested projects

`vitest -p mcp-node` is `--project mcp-node`. A config file referenced from `test.projects`
may itself declare `projects`; the children are named `parent (child)` and `-p parent` runs
all of them:

```ts
// packages/app/vitest.config.ts
export default defineConfig({ test: { projects: ['./unit.config.ts', './e2e.config.ts'] } })
```

Do NOT nest here yet: `vitest-projects.mjs` regex-scans the ROOT config for quoted
`*.config.ts` paths, and a nested list would silently leave CI's shared-layer step.

### Inline projects inherit the root config and share one Vite server

Inline `test.projects` entries inherit root `plugins` / `resolve.alias` (`extends: true` is
the default; `extends: false` isolates) and reuse the root Vite server (`sharedViteServer`,
default `true`; `false` re-instantiates plugins per project). Every project here is a
referenced file, so neither applies until one becomes inline.

### `testNamePattern` matches the full suite chain

`-t` matches against `suite > test` joined by `' > '`, not by spaces: `-t adds` or
`-t 'math.*adds'`, never `-t 'math adds'`. No script or CI job on this tree passes `-t`.

## Pools, isolation and caches

- Timeouts per project are ceilings sized on a recorded measurement
  (`resources/async-and-timers.md`). `mcp-smoke` serialises through `maxWorkers: 1`.
- The duration line names where the time goes, in percentages:
  `Duration 4.82s (import 73%, transform 14%, tests 13%, worker 1%)` (arch-lint-node, measured).
  A high `import` share is the in-body `await import()` and heavy-static-graph class; a high
  `environment` share is jsdom setup, where `vmForks`/`vmThreads` pools help. Below it vitest
  prints a hint when the timings suggest a cheaper configuration — e.g. `Isolate 13 workers
  spawned · ~264ms startup each … at least ~881ms faster with isolate: false`. A hint is a
  measurement, not an instruction: `isolate: false` reuses workers across files, which is
  exactly the state-leak surface `isolation-and-state.md` is about.

### `vitest doctor`

```bash
vitest doctor
```

Runs the suite under alternative configurations (pools, isolation, environments) and prints
a recommendation. Run it once at the upgrade and paste the output in the PR; it is the
measurement the pool choice should rest on.

### `fsModuleCache`

```bash
vitest run --fsModuleCache            # or test: { fsModuleCache: true }
vitest --clearCache                   # drop it (and every other vitest cache)
```

Persists transformed modules under `node_modules/.vitest-cache` (`--fsModuleCachePath` moves
it) across reruns AND across separate processes. Plugins whose output depends on more than
the source declare it through `defineCacheKeyGenerator`.

**It pays where the same graph is transformed more than once, and only there.** Adopted in
CI's `stress-changed-tests` job, which runs the changed files five times in fresh processes
plus one `--repeats=3` pass; every other CI job runs its project once and gains nothing.
Measured on that exact shape (four changed `web-jsdom` files, five fresh processes,
interleaved rounds): faster in both paired rounds, 48.2s/47.0s plain against 39.7s/40.0s
cached — median 47.6s → 39.8s. Vitest's own performance hint is what named it, printed
under the duration line on CI with the number behind it (`transforming modules took 5.91s ·
46% of tracked time, re-done on every run`). Read the hint; it is a measurement of the run
that just happened.

### `injectCjsGlobals: false`

Stops vitest injecting `module`, `exports`, `require`, `__filename`, `__dirname` into ES
modules. Shared-layer packages must not read `__dirname` anyway (`architecture-map.md` rule
1), so a test that passed only because vitest injected it would then fail honestly.

### Worker ids

`VITEST_POOL_ID` / `VITEST_WORKER_ID` start at 1, not 0 (they were 0-based before Vitest 5).
Nothing on this tree reads them.

## Artifacts and reporters

- Browser failure traces: `<package>/tmp/vitest-traces`, most recent run only
  (`resources/browser-mode.md`).
### One `.vitest/` directory for everything

| Artifact | Path |
|---|---|
| attachments (what vitest copies out of a failing browser test) | `.vitest/attachments/` |
| failure screenshots | `.vitest/attachments/failure-screenshots/` |
| blob reports (`--reporter=blob`) | `.vitest/blob/` |
| HTML reporter | `.vitest/` (`outputDir`) |
| JSON / JUnit reporters | `.vitest/json/`, `.vitest/junit/` |

One `.gitignore` entry (`.vitest/`). Third-party reporters get the same convention through
`vitest.createReport(scope)`. `toMatchScreenshot` has its own
`browser.expect.toMatchScreenshot.screenshotDirectory`. The directory is at the REPO ROOT
even for a package's project: a `web-browser` failure's trace copy landed in
`<root>/.vitest/attachments/`, not under `apps/web`. The 155-char browser title budget
(`browser-test-name-length.test.ts`) is measured against that flattened name, and the shape
was re-measured at the 5.0.0 upgrade: 186 characters for an 86-character sanitized title,
which is the guard's fixed overhead plus the title, unchanged.

### Single-file HTML report

```ts
export default defineConfig({ test: { reporters: [['html', { singleFile: true }]] } })
```

Inlines the UI assets, metadata and attachments — including `traceView` replays — into one
`index.html`, which is the shape a CI artifact wants. The multi-file form measured 1.7MB for
20 page files with replays, of which ~0.9MB is the UI's own static assets; the report data
itself was 774KB gzipped with replays against 177KB without (`browser-mode.md` › Traces).
`pnpm test:browser:replay` runs the three browser projects with `traceView` and this
reporter.

### Merging reports across environments

`vitest --merge-reports` now merges blob reports from NON-sharded runs in different
environments — the shape CI's split browser / jsdom / node jobs produce.

### Reporter details

JSON reporter `filterMeta`; JUnit reporter accepts jest-junit-compatible naming options;
`TestCase.logs()` exposes a test's console output to reporters and the advanced API (what
`flake-watch.mjs` would read if it ever wanted more than the annotation title); test titles
and `test.each` placeholders format through `pretty-format` (interpolated strings are no
longer quoted — snapshots and `-t` patterns that quoted them change).

### Vitest UI and the browser orchestrator need the printed URL

`/__vitest__/` requires a token and `/__vitest_test__/` a `sessionId`, both in the URL vitest
prints at startup. Do not hand-build either. `browser.api` moved to top-level `api`.

## Benchmarks (`pnpm bench`)

`vitest bench --project "canvas-render-node (bench)"` runs
`packages/canvas-render/src/**/*.bench.ts`. **Bench mode runs each project's benchmark
files under a sibling project whose name carries a ` (bench)` suffix, and that full string
is what `--project` / `-p` must be given** — measured: `--project canvas-render-node` and
`-p canvas-render-node` both answer `No projects matched the filter`. The discipline —
instrument first, interleaved runs, a second bench in the same process is not a control —
is the `measured-change` skill.

### `bench` as a test-context fixture

```ts
import { expect, test } from 'vitest'

test('compare parsers', async ({ bench }) => {
  const result = await bench.compare(
    bench('JSON.parse', () => { JSON.parse('{"key":"value"}') }),
    bench('custom parser', () => { customParse('{"key":"value"}') }),
  )
  expect(result.get('JSON.parse')).toBeFasterThan(result.get('custom parser'))
})

test('single', async ({ bench }) => {
  await bench('sort', () => [3, 1, 2].sort()).run()
})
```

`bench` is not a top-level import: it is destructured from the test context inside
`test()` in a benchmark file (the fixture throws in an ordinary test file), which gives
benchmarks fixtures, lifecycle hooks, retries, filtering and assertions. Options:

- **`{ timeout: 0 }` on every bench test.** A benchmark's duration IS its output, and the
  project's per-test ceiling applies to bench tests too — the edge search's four rows
  measured 101s against `canvas-render-node`'s 20s and failed on it.
- `bench.compare(...regs, { time, iterations })` prints ONE table for its rows; a pair that
  is the measurement (plain vs styled) belongs in one `compare`, not two tests.
- `bench('name', { writeResult: './tmp/bench/name.json' }, fn)` stores the result on a
  successful run (overwritten each time, not written when `fn` throws);
  `bench.from('before', './tmp/bench/name.json')` replays it as a row of the same table —
  a same-machine, same-sitting before/after done by the runner. `perProject: true` with
  `${projectName}` in the path spreads it across projects.
- The module runner serves ESM exports through getters, and a hot loop that calls its own
  module's helpers tens of millions of times trips `Benchmark Warning … accessed module
  export getters too many times`. `const _fn = fn` in the bench file only bypasses the
  bench file's imports, not the source's internal ones, and native ESM cannot resolve this
  repo's `.js` specifiers to `.ts` — so `canvas-render` sets
  `benchmark.suppressExportGetterWarnings: true` and says why. The overhead is identical on
  both sides of an interleaved comparison, which is the only comparison allowed anyway.

Custom benchmark providers replace Tinybench; output lands in the `default` and `json`
reporters. Gone since Vitest 5: module-scope `bench()`, `bench.skip/only/todo`,
`benchmark.reporters` / `outputFile` / `compare` / `outputJson`, `--compare`,
`--outputJson`.

## Custom matchers

None on this tree today. `expect.extend({ toBeFoo(received, ...) { return { pass, message } } })`
plus a module augmentation for the type.

### `Matchers<R, T>`

```ts
declare module 'vitest' {
  interface Matchers<R, T> {
    toBeFoo: () => R              // R: void sync, Promise<void> under .resolves/.rejects/expect.poll/expect.element
    toEqualTyped: (expected: T) => R   // T: the received type, so expect(1).toEqualTyped('2') is a type error
  }
}
```

`Assertion<R, T>` (`Assertion<void, string>`, `Assertion<Promise<void>, string>`). Custom
matchers can reach the underlying Chai `assertion` object. Also: `toThrow('')` matches ANY
error message (use `/^$/` for an empty one), and `vi.useFakeTimers()` fakes `Temporal`
(`fakeTimers.toNotFake: ['Temporal']` opts out).

## Coverage

`coverage.autoAttachSubprocess` tracks `node:child_process` / `node:worker_threads` under
the v8 provider; `coverage.thresholds.perFile` accepts objects and glob thresholds no longer
inherit the top-level `perFile`; include/exclude match relative project paths precisely (a
bare `'src'` no longer matches unintended paths; `contains` is removed); istanbul moved to
`@vitest/istanbuljs`. `pnpm test:coverage` is mcp-server's v8 run.
