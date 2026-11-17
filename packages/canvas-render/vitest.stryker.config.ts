import { defineConfig } from 'vitest/config'

/**
 * Stryker-only vitest config. Never use it for a normal run or in CI's test
 * jobs — `vitest.node.config.ts` is the project CI runs.
 *
 * The exclusions are about run TIME rather than value. Stryker re-runs the
 * tests covering a mutated line once per mutant, so a single slow file is
 * multiplied by the mutant count. The `*.rust.test.ts` suites (the routing
 * and layout scoreboards among them) are excluded as the node project
 * excludes them: they need the oracle artifact, and judge the Rust core, not
 * a line Stryker mutates here.
 *
 * Every cost and budget test is excluded too (`*cost*`, `*budget*`). Each
 * bounds how much WORK a layout does on an input sized to make a quadratic
 * blow up, so none asserts what a mutated line computes, and together they
 * were 87 of 2182 tests and 294 of 412 seconds. A static mutant re-runs every
 * test, so those seconds are paid once per static mutant: the weekly leg that
 * held the (since deleted) TypeScript edge router's mutants went from a 15 s
 * test run to 138 s and no longer fit its job. `tools/arch-lint/src/mutation-lane.test.ts` holds the
 * glob to the files that exist.
 *
 * `tidy-quality.test.ts` is the same KIND of instrument and is deliberately
 * NOT excluded, because it costs about a second — and because it is the only
 * thing in the repo that can kill its file's mutants at all. Measured:
 * `tidy.ts` sat at 52.63% with every correctness test green, since forcing
 * the overlap axis to one direction leaves the result separated, on-grid,
 * idempotent and deterministic while dragging boxes 50% further. Adding the
 * scoreboard took it to 80.70%. A cheap scoreboard belongs in the lane; an
 * expensive one is what the scoreboard exclusions are about.
 */
export default defineConfig({
  test: {
    name: 'canvas-render-node',
    environment: 'node',
    setupFiles: ['./vitest.stryker-setup.ts'],
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/**/*.browser.test.ts',
      'src/**/*.rust.test.ts',
      'src/**/*cost*.test.ts',
      'src/**/*budget*.test.ts',
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
