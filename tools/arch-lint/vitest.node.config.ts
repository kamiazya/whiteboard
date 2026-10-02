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
  },
})
