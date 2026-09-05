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
    // `include` above matches *.test.ts and nothing else. Bench mode runs
    // them under a sibling project named `canvas-render-node (bench)`, and
    // that full string is what `--project` has to be given (`pnpm bench`).
    benchmark: {
      include: ['src/**/*.bench.ts'],
      // Vite's module runner serves ESM exports through getters, and the
      // edge search calls its own helpers (edge-rules, edge-geometry) tens
      // of millions of times per run, so vitest warns that the getters skew
      // the numbers. The two fixes it offers do not apply here: a local
      // alias in the bench file only bypasses the bench file's OWN imports,
      // not the source's internal ones, and native ESM cannot resolve this
      // package's `.js` specifiers to `.ts` sources. The overhead is the
      // same on both sides of an interleaved before/after on one machine,
      // which is the only comparison `measured-change` allows anyway.
      suppressExportGetterWarnings: true,
    },
  },
})
