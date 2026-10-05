import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'search-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // `vitest bench` only — `vitest run` never picks these up. Bench mode
    // runs them under a sibling project named `search-node (bench)`, which is
    // what `--project` has to be given (`pnpm bench`). snippet.bench.ts is
    // what notices the excerpt path getting slower, and the pair of rows in
    // it is the measurement, not either row.
    benchmark: { include: ['src/**/*.bench.ts'] },
  },
})
