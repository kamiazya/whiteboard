import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'search-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // `vitest bench --project search-node` only — `vitest run` never picks
    // these up. snippet.bench.ts is what notices the excerpt path getting
    // slower, and the pair of rows in it is the measurement, not either row.
    benchmark: { include: ['src/**/*.bench.ts'] },
  },
})
