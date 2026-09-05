# Running and configuring vitest in this repo

Projects, filters, pools, caches, artifacts, reporters, benchmarks and `expect` extensions.
Entries tagged `[v5]` need Vitest ≥ 5; this tree's version is the `vitest:` line of
`pnpm-workspace.yaml`'s catalog (4.1.10 today). A config key the installed version does not
know is IGNORED silently, so a `[v5]` option in a v4 config does nothing rather than failing
— check the version before relying on one.

## Projects and filters

- The root `vitest.config.ts` lists every project config file; each declares a `name:`
  (`tools/checks/src/vitest-projects.mjs` throws on one without, since CI derives the
  shared-layer step from the list). `vitest run --project <name>` runs one;
  `pnpm test:browser` runs the three browser projects.
- **A filter that matches nothing beside one that does is silent.** vitest errors only when
  the whole `--project` set is empty (`resources/isolation-and-state.md`). Match the local
  command to the CI job and treat a low count as a missed filter.

### `-p` shorthand and nested projects `[v5]`

`vitest -p mcp-node` is `--project mcp-node`. A config file referenced from `test.projects`
may itself declare `projects`; the children are named `parent (child)` and `-p parent` runs
all of them:

```ts
// packages/app/vitest.config.ts
export default defineConfig({ test: { projects: ['./unit.config.ts', './e2e.config.ts'] } })
```

Do NOT nest here yet: `vitest-projects.mjs` regex-scans the ROOT config for quoted
`*.config.ts` paths, and a nested list would silently leave CI's shared-layer step.

### Inline projects inherit the root config and share one Vite server `[v5]`

Inline `test.projects` entries inherit root `plugins` / `resolve.alias` (`extends: true` is
the default; `extends: false` isolates) and reuse the root Vite server (`sharedViteServer`,
default `true`; `false` re-instantiates plugins per project). Every project here is a
referenced file, so neither applies until one becomes inline.

### `testNamePattern` matches the full suite chain `[v5]`

`-t` matches against `suite > test` joined by `' > '`, not by spaces: `-t adds` or
`-t 'math.*adds'`, never `-t 'math adds'`. No script or CI job on this tree passes `-t`.

## Pools, isolation and caches

- Timeouts per project are ceilings sized on a recorded measurement
  (`resources/async-and-timers.md`). `mcp-smoke` serialises through `maxWorkers: 1`.
- The duration line names where the time goes; on Vitest 5 it carries percentages `[v5]`:
  `Duration 3.76s (environment 79%, import 13%, transform 6%, tests 1%, setup 1%)`. A high
  `import` share is the in-body `await import()` and heavy-static-graph class; a high
  `environment` share is jsdom setup, where `vmForks`/`vmThreads` pools help.

### `vitest doctor` `[v5]`

```bash
vitest doctor
```

Runs the suite under alternative configurations (pools, isolation, environments) and prints
a recommendation. Run it once at the upgrade and paste the output in the PR; it is the
measurement the pool choice should rest on.

### `fsModuleCache` `[v5]`

```ts
export default defineConfig({ test: { fsModuleCache: true } })
```

Persists transformed modules on disk across reruns AND across separate processes (the five
fresh-process stress runs included). Plugins whose output depends on more than the source
declare it through `defineCacheKeyGenerator`. Candidate for the import-cost timeout class;
verify with the duration breakdown before and after, on a quiet tree.

### `injectCjsGlobals: false` `[v5]`

Stops vitest injecting `module`, `exports`, `require`, `__filename`, `__dirname` into ES
modules. Shared-layer packages must not read `__dirname` anyway (`architecture-map.md` rule
1), so a test that passed only because vitest injected it would then fail honestly.

### Worker ids `[v5]`

`VITEST_POOL_ID` / `VITEST_WORKER_ID` start at 1, not 0. Nothing on this tree reads them;
anything deriving a database name or port from one adjusts at the upgrade.

## Artifacts and reporters

- Browser failure traces: `<package>/tmp/vitest-traces`, most recent run only
  (`resources/browser-mode.md`).
- `.gitignore` carries `.vitest-attachments/` for the attachments vitest copies out of a
  failing browser test.

### One `.vitest/` directory for everything `[v5]`

| Artifact | Vitest 4 | Vitest 5 |
|---|---|---|
| attachments | `.vitest-attachments/` | `.vitest/attachments/` |
| failure screenshots | `__screenshots__/` | `.vitest/attachments/failure-screenshots/` |
| blob reports (`--reporter=blob`) | `.vitest-reports/` | `.vitest/blob/` |
| HTML reporter | `html/` | `.vitest/` (`outputDir`) |
| JSON / JUnit reporters | stdout | `.vitest/json/`, `.vitest/junit/` |

One `.gitignore` entry (`.vitest/`). Third-party reporters get the same convention through
`vitest.createReport(scope)`. `toMatchScreenshot` has its own
`browser.expect.toMatchScreenshot.screenshotDirectory`. The 155-char browser title budget
(`browser-test-name-length.test.ts`) was measured against the flattened name under
`.vitest-attachments/` and is re-measured at the upgrade.

### Single-file HTML report `[v5]`

```ts
export default defineConfig({ test: { reporters: [['html', { singleFile: true }]] } })
```

Inlines the UI assets, metadata and attachments — including `traceView` replays — into one
`index.html`, which is the shape a CI artifact wants.

### Merging reports across environments `[v5]`

`vitest --merge-reports` now merges blob reports from NON-sharded runs in different
environments — the shape CI's split browser / jsdom / node jobs produce.

### Reporter details `[v5]`

JSON reporter `filterMeta`; JUnit reporter accepts jest-junit-compatible naming options;
`TestCase.logs()` exposes a test's console output to reporters and the advanced API (what
`flake-watch.mjs` would read if it ever wanted more than the annotation title); test titles
and `test.each` placeholders format through `pretty-format` (interpolated strings are no
longer quoted — snapshots and `-t` patterns that quoted them change).

### Vitest UI and the browser orchestrator need the printed URL `[v5]`

`/__vitest__/` requires a token and `/__vitest_test__/` a `sessionId`, both in the URL vitest
prints at startup. Do not hand-build either. `browser.api` moved to top-level `api`.

## Benchmarks (`pnpm bench`)

`vitest bench --project canvas-render-node` runs `packages/canvas-render/src/**/*.bench.ts`.
The discipline — instrument first, interleaved runs, a second bench in the same process is
not a control — is the `measured-change` skill. The API is Vitest's:

- **Vitest 4**: `import { bench, describe } from 'vitest'`; `bench('name', fn)` at module
  scope; `pnpm bench | grep <name> | awk ...` parses the table.

### `bench` as a test-context fixture `[v5]`

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

`bench` is no longer a top-level import: it is destructured from the test context inside
`test()` in a benchmark file, which gives benchmarks fixtures, lifecycle hooks, retries,
filtering and assertions. `writeResult` stores a run; `bench.from()` replays a stored
baseline for comparison, which is the interleaved before/after `measured-change` asks for,
done by the runner. Custom benchmark providers replace Tinybench; output lands in the
`default` and `json` reporters. REMOVED: module-scope `bench()`, `bench.skip/only/todo`,
`benchmark.reporters` / `outputFile` / `compare` / `outputJson`, `--compare`,
`--outputJson`. Three files on this tree use the v4 shape:
`packages/canvas-render/src/layout/{edges/spatial-edges,nodes/mdast-blocks,spatial-canvas}.bench.ts`.

## Custom matchers

None on this tree today. `expect.extend({ toBeFoo(received, ...) { return { pass, message } } })`
plus a module augmentation for the type.

### `Matchers<R, T>` `[v5]`

```ts
declare module 'vitest' {
  interface Matchers<R, T> {
    toBeFoo: () => R              // R: void sync, Promise<void> under .resolves/.rejects/expect.poll/expect.element
    toEqualTyped: (expected: T) => R   // T: the received type, so expect(1).toEqualTyped('2') is a type error
  }
}
```

`Assertion<T>` became `Assertion<R, T>` (`Assertion<void, string>`, `Assertion<Promise<void>,
string>`). Custom matchers can reach the underlying Chai `assertion` object. Also `[v5]`:
`toThrow('')` matches ANY error message (use `/^$/` for an empty one), and `vi.useFakeTimers()`
fakes `Temporal` (`fakeTimers.toNotFake: ['Temporal']` opts out).

## Coverage `[v5]`

`coverage.autoAttachSubprocess` tracks `node:child_process` / `node:worker_threads` under
the v8 provider; `coverage.thresholds.perFile` accepts objects and glob thresholds no longer
inherit the top-level `perFile`; include/exclude match relative project paths precisely (a
bare `'src'` no longer matches unintended paths; `contains` is removed); istanbul moved to
`@vitest/istanbuljs`. `pnpm test:coverage` is mcp-server's v8 run.
