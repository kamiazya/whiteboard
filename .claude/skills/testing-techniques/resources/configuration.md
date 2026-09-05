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
vitest doctor --project <name> [--project <name>…]
```

Runs the suite under alternative configurations (pool, isolation, `fsModuleCache`) twice
each and prints a recommendation with the deltas.

**It measures the projects you point it at, and its recommendation is scoped to them.**
Measured here on `arch-lint-node` + `search-node` + `canvas-render-node`: baseline 26.18s,
`pool: 'threads'` −3%, `fsModuleCache: true` ±0%, **`isolate: false` −42%** — "Recommendation:
isolate: false", with the caveat that the suite "passed twice with a shuffled file order
under shared state, so it is likely - but not guaranteed - that no test depends on
isolation". Those three are the small, pure, node-only projects. Run against the two that
actually hold state, the same option produces **464 failures** (see below). Doctor's own
output says it "overrides options for all projects at once; apply the change per project if
they need different settings" — take that literally.

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
the v8 provider (**no effect here** — see the refuted list below); `coverage.thresholds.perFile` accepts objects and glob thresholds no longer
inherit the top-level `perFile`; include/exclude match relative project paths precisely (a
bare `'src'` no longer matches unintended paths; `contains` is removed); istanbul moved to
`@vitest/istanbuljs`. `pnpm test:coverage` is mcp-server's v8 run.

## Measured and refuted

Four options that read as obvious wins and are not, each checked against this repo rather
than argued about. Re-open one only with a new measurement, not with the release notes.

### `isolate: false` — REFUTED, 464 failures

`vitest doctor` recommends it at −42% on the pure node projects. Run on the two that hold
state (`web-jsdom` + `mcp-node`, 7997 tests):

| | result | wall |
|---|---|---|
| `isolate: true` (default) | 7988 passed, 9 skipped | 355s |
| `--no-isolate` | **464 failed**, 7524 passed | 269s |

The failures are the shapes `isolation-and-state.md` is about, now arriving in bulk: mock
implementations bleeding between files (`expected "vi.fn()…"`), counters and ids carried
across (`expected N to be N`), 54 timeouts, and 102 import-resolution errors from a worker
reused across module graphs. `useDocumentSync` (36), `use-browser-document-controller` (35),
`workspace-plane` (33) and `version-store` (30) lead. Reusing a worker across files is
precisely what the repo's setup-file teardown, its per-file data dir and its `localStorage`
clear exist to make unnecessary — 24% of wall clock does not buy that back.

### `browser.locators.errorFormat: 'aria'` — nothing to adopt

The default is already `'all'`, which prints the ARIA tree AND the HTML. Measured on a
forced miss: the error leads with `ARIA tree:` (roles and accessible names, four lines for a
dialog) and follows with the HTML. Setting `'aria'` only REMOVES the HTML — a choice about
output volume, not a capability. Leave it at the default; the tree that makes a
`getByRole` miss readable is there already.

### `coverage.autoAttachSubprocess` — no-op for this repo's coverage lane

`pnpm test:coverage` is `vitest run --coverage --project mcp-node`, and every subprocess call
site in that project takes an INJECTED spawn (`backup-subprocess.test.ts` hands
`runBackupInSubprocess` a fake `spawnBackup` that emits on a stub child). No real child
process runs, so there is nothing to attach to. The project that does spawn real children,
`mcp-smoke`, is not in the coverage command — putting it there is the change worth arguing
about, and this option is only useful after it.

### `detectAsyncLeaks` — a real detector, currently reporting one upstream artefact 25 times

```bash
vitest run --detect-async-leaks --project <name>    # node projects only; ignored in browser mode
```

Reports async resources still open when a test file finishes, with the import that created
them. It is diagnostic, not a gate — the run stays green.

On this tree it reports **25 PIPEWRAP leaks, and every one is the same upstream artefact**.
Bisected to a minimal reproducer: `import { unified } from 'unified'` — no plugin, no
`.parse()`, nothing else in the file. Every leaking file's import graph reaches `unified`
(most through `@kamiazya/whiteboard-codec`'s markdown pipeline); no non-leaker's does. Not
`process.stdout` (a probe touching `isTTY` reports nothing), not the remark plugins
(`remark-gfm`, `remark-math`, `remark-stringify` and `yaml` each import clean), not the
cross-package alias (`@kamiazya/whiteboard-model` imports clean), and not project-specific
(it reproduces inside `codec-node` on codec's own index).

So: do not wire it into CI. Twenty-five copies of one artefact would bury the first real
leak. Reach for it when hunting a specific leaked timer or handle, and discount any report
whose pointer lands on a `unified` import. Re-measure if the codec's markdown stack changes —
if the count moves away from 25, something new is leaking.

### `expect.schemaMatching` — not better at the sites this repo has

`expect(value).toEqual(expect.schemaMatching(zodSchema))` validates against any Standard
Schema v1 object. The repo's five candidate sites are all
`expect(() => schema.parse(x)).not.toThrow()`, and measured side by side on the same failure
both messages carry the same Zod issues — `not.toThrow` prints them as a plain list,
`schemaMatching` as a `SchemaMatching{…}` deep-equal diff. Neither is clearly better, so the
existing sites stay as they are.

Where it earns its place is the shape `not.toThrow` cannot express at all — one field of a
larger object, checked against a schema inside a single equality:

```ts
expect(response).toEqual({
  id: expect.any(String),
  config: expect.schemaMatching(runtimeConfigSchema),
})
```

Reach for it there; do not churn a passing `not.toThrow` into it.

### The past releases' features, checked the same way

Read after the 5.0 upgrade, because features shipped in 3.x/4.x had never been checked here
at all. `vi.defineHelper` was the one worth adopting (`executable-rungs.md`). The rest:

- **Test `{ signal }` (3.2)** cannot address the shape it looks made for. The signal is
  aborted on timeout, but `userEvent` accepts no signal anywhere — `keyboard` is
  `(text: string) => Promise<void>`, and the whole `UserEvent` interface declares none — so
  the overrun that keeps typing into the next test has nothing to hand it to
  (`browser-mode.md`). It is usable where the TEST awaits cancellable work of its own; the
  repo's 18 in-test `fetch` calls are the only candidates and none is long enough to matter.
- **`locators.extend` (3.2)** would rewrite `focusEditable`'s 43 call sites from DOM-query
  closures to locators, to gain retry `vi.waitFor` already provides and lose the diagnostics
  the helper exists for — its message distinguishes three causes that reached the same line
  in CI and were otherwise indistinguishable.
- **`page.frameLocator()` (4.0)** has no site: the iframe tests assert the ELEMENT (sandbox
  attributes, the cap of three live frames) and never its content, which is sandboxed without
  `allow-same-origin` by design.
- **`toBeInViewport` (4.0)** has no site either. The repo's `getBoundingClientRect` reads are
  pointer coordinates for a synthetic touch and box dimensions for a diagnostic string —
  neither asks whether an element is in the viewport.
- **The `agent` reporter (4.1)** produces the same content as the default here: 14 non-noise
  lines each on a green `web-jsdom` run. It suppresses passing-test output, and this repo's
  default output has almost none — 94 of 108 lines are jsdom's `Not implemented:
  HTMLCanvasElement getContext` warnings, which no reporter controls. `AI_AGENT` is not set
  in Claude Code, so it does not auto-enable either.
- **`sequence.groupOrder` (3.2)** solves a conflict this repo does not have: `mcp-smoke`
  serialises with `maxWorkers: 1` for daemon ports WITHIN its project, and nothing binds a
  fixed port across projects.
- **Test tags (4.1)** as a quarantine mechanism improve nothing today — there are zero
  `QUARANTINE(` markers in the tree, and the marker carries a date, an issue and a reason
  that a tag cannot.

### Environment cost: a per-file `node` environment, and why NOT happy-dom

Vitest 5's environment line reports what no earlier version did, and it named the largest
single cost in the repo's largest project — larger than running the tests:

```
Environment  |web-jsdom| jsdom was created 353 times · 234.29s total, 38% of tracked time
```

Two levers, both measured end to end. **One adopted, one refused.**

**Adopted — `// @vitest-environment node` on the files that never touch a DOM.** 145 of
web-jsdom's 353 files. The docblock keeps the file in its project, with its setup file and
its CI job; it simply stops paying for a DOM it does not use.

| | wall | environment share |
|---|---|---|
| the 149-file subset under jsdom | 82s | 46% (100.9s) |
| the same subset under `node` | **47s** | **1%** |
| whole project before | 219s | 38% (234.3s) |
| whole project after | **188s** | **26%** (135.5s) |

**The set is what the RUN says, not what a grep says** — and not what ONE run says either.

A "no testing-library, no `document`/`window`/`localStorage`/`indexedDB`" scan proposed 149.
Four failed immediately with `ReferenceError: document is not defined`, the dependency being
indirect (CodeMirror's completion source, three lib modules). The remaining 145 passed a full
`web-jsdom` run — and **two of them still failed in CI**, under
`stress-changed-tests`'s five fresh processes and `--repeats=3`:

- `sse-shared-stream-source.test.ts` installs its own `FakeSharedWorker` over
  `globalThis.SharedWorker`, so it reads as DOM-free and passes alone; its eviction path
  does not survive repetition without jsdom (`expected [] to have a length of 1`).
- `save-scheduler.property.test.ts` timed out at 5000ms with a seed in its name — the
  budget shape, not a counterexample (`async-and-timers.md`), and only under load.

Both went back to jsdom; 141 remain. **Certify an environment swap under the stress shape,
never under one pass**: three fresh runs plus `--repeats=3` over the whole annotated set is
what the CI step does and what this now clears. The direction is still the safe one — a file
that needs a DOM and does not get one fails, loudly or under repetition, where a file that
stops needing one merely keeps paying.

**Refused — `happy-dom` as the environment.** It is faster, and that is not the question.
Measured on the whole project on top of the change above: 188s → **158s (-16%)**,
environment 26% → 16%, with 3 failures out of 3682. Two of the three are the reason:

- `HeaderBranchChip` reads `getAttribute('style')` and expects `rgb(147, 51, 234)`. jsdom
  serialises a hex colour to `rgb()` the way Chrome does; happy-dom keeps `#9333ea`. The
  test's own comment already said which browser behaviour it was pinning.
- `initial-tool` simulates private mode with `vi.spyOn(Storage.prototype, 'setItem')`. Under
  jsdom `sessionStorage` routes through the prototype and the spy fires, so the test
  exercises the `catch` branch it exists for. Under happy-dom it does not fire, the write
  succeeds, and the assertion reads `'select'` where it expects `null`.

That second one is the argument, and it is this repo's own recorded hazard: **a guard that
never reaches its subject passes, and reads exactly like a guard that checked.** The failure
was visible only because the assertion was strong. A test whose only claim was
`expect(() => writeLastTool('select')).not.toThrow()` would have gone green under happy-dom
while never entering the branch — silently, across a 353-file suite, wherever prototype-level
interception is how a browser condition gets simulated. 16% does not buy that.

(The third failure is happy-dom being MORE correct — `navigator.clipboard` is getter-only, as
in a real browser, so the test's `Object.assign(navigator, …)` throws. That one is the test's
sloppiness and would be worth fixing either way.)

### `injectCjsGlobals: false` — already held by a stronger rung

It would make a shared-layer package reading `__dirname` fail at test time. `tools/arch-lint`'s
scanner already bans `__dirname`, `__filename`, `process`, `Buffer` and `global` as ambient
identifiers across the shared layer, statically — and measured zero occurrences today, tests
included. A runtime rung behind a static one that already covers the same identifiers is
redundancy, not coverage.

