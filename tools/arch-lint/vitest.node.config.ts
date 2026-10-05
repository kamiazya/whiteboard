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
    // later file imports. Checked rather than assumed. The only module-scope
    // state in a helper is three memos keyed by file name AND full text
    // (`stripCommentsAndStrings`, `commentRanges`, `cycle-check.ts`'s import
    // specifiers), so a later file gets the answer an isolated one would and an
    // edited file is a miss rather than a stale hit; no test uses fake timers or `chdir`,
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
    //
    // What a shared worker lets the memos above return is re-parsing. Over a
    // whole run (2026-10-05, 2093 tests) the TypeScript parse was the cost that
    // scaled with the tree — 39% of parse time re-parsed a (file, text) the
    // same worker had already parsed — while directory walks took under a
    // second per worker and file reads a few, so neither is memoised. A kept
    // `SourceFile` would return all of it and costs about 540MB of heap for the
    // tree in EVERY worker (measured), so the memos keep what a guard derives
    // instead, and `countNamedUses` skips the parse for text that cannot spell
    // a wanted name. Three interleaved pairs at load average 15-23 on 4 cores:
    // CPU (user + sys) 170.9, 171.8, 165.7s before against 157.3, 155.4, 154.4s
    // after (mean 169.4 -> 155.7, -8%).
    isolate: false,
  },
})
