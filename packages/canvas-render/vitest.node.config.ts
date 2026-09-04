import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'canvas-render-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.browser.test.ts'],
    // Vitest's default is 5s, which this project never chose — and the
    // live-drag parity property sits right at it. Measured: 1427/1642/1512ms
    // with its file alone, 4654ms with all vitest projects running, so the
    // margin is a few hundred milliseconds of noise and the same run is red
    // or green by luck. It timed out twice that way, each time reading as a
    // property failure because @fast-check/vitest prints the seed in the test
    // NAME — sending the reader after a shrunk counterexample that does not
    // exist.
    //
    // 20s is ~4x the loaded measurement, and the number this package's own
    // stryker config already declares. It does NOT double as a cost guard:
    // spatial-canvas.bench.ts is what notices this path getting slower, and a
    // timeout that tried to do both would have to sit close enough to the
    // real cost to keep flaking.
    testTimeout: 20_000,
    // `vitest bench` only — `vitest run` never picks these up, since
    // `include` above matches *.test.ts and nothing else.
    benchmark: { include: ['src/**/*.bench.ts'] },
  },
})
