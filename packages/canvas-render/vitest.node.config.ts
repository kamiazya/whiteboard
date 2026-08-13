import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'canvas-render-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.browser.test.ts'],
    // `vitest bench` only — `vitest run` never picks these up, since
    // `include` above matches *.test.ts and nothing else.
    benchmark: { include: ['src/**/*.bench.ts'] },
  },
})
