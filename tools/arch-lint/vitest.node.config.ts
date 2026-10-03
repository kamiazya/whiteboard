import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'arch-lint-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Every guard here SCANS: it walks other packages' source, and the
    // exemption check runs Biome over the listed files. That costs seconds
    // on a quiet tree and much more at `git push`, where lefthook runs this
    // whole project beside `pnpm -r typecheck` and `lint` — measured there,
    // one push timed out six guards at once (7.8s, 12.0s, 14.6s, 15.3s,
    // 16.9s, 23.4s) against the 5000ms default. A timeout says nothing about
    // the repo, so the gate failed on its own budget rather than on a
    // finding. A ceiling sized on those numbers, not a delay.
    testTimeout: 60_000,
    // `fsModuleCache` is deliberately not set. It persists the TRANSFORM step
    // only, and vitest's own breakdown for this project puts transform at 1-4%
    // of the run (import 68-79%, tests 20-30%) — so the most it can return is
    // that. Measured on one box under heavy contention, three interleaved
    // plain/cached pairs of the whole project: CPU time (user + sys) 94.4s
    // plain against 93.2s cached, wall time inside the noise (100-152s at a load
    // average of 23-29). It pays in CI's stress job because that job re-runs
    // the same graph five times; this project runs once per push. What the time
    // is, is import: one fresh worker per test file, each loading its own module
    // graph, which a transform cache does not touch.
    //
    // `isolate: false` is what does touch it, and this project can take it
    // where the two that hold state cannot (`web-jsdom` + `mcp-node` failed 464
    // tests under it): every guard here reads files, and none mutates what a
    // later file imports. Checked rather than assumed. No helper module holds
    // mutable module-scope state (the only `let` and `Map` caches are inside
    // one test file or one function), no test uses fake timers or `chdir`,
    // the one that stubs the environment unstubs it in an `afterEach`, and
    // the one that `vi.doMock`s `vitest` itself unmocks it and resets the
    // module registry in `afterAll`. Then run: 5 of 5 plain runs and one `--sequence.shuffle` run
    // passed 1224 of 1224. Both the audit and the runs can only vouch for what
    // exists today, so the instrument was checked too: two tiny files sharing a
    // counter pass isolated and fail under `--no-isolate`, so a leak is visible
    // in this mode rather than absorbed.
    //
    // Measured, three interleaved plain/no-isolate pairs of the whole project
    // on one 4-core box at load average 17-27: CPU time (user + sys) 98.8,
    // 108.3, 99.4s plain against 54.1, 55.1, 53.6s (mean 102.1 -> 54.2, -47%),
    // wall 154.9, 151.0, 130.9s against 75.5, 71.5, 50.5s (mean 145.6 -> 65.8).
    // CPU is the figure to trust; the wall numbers ride the box's load. A guard
    // that starts to depend on a previous file's state fails here first, so
    // when one does, fix the guard rather than reverting this.
    isolate: false,
  },
})
