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
  },
})
