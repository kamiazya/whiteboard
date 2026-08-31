import { defineConfig } from 'vitest/config'

/**
 * Stryker-only vitest config. Never use it for a normal run or in CI's test
 * jobs — `vitest.node.config.ts` is the project CI runs.
 *
 * Two exclusions, both about run TIME rather than value. Stryker re-runs the
 * tests covering a mutated line once per mutant, so a single slow file is
 * multiplied by the mutant count: `edge-routing-quality.test.ts` alone takes
 * ~22s of the project's ~30s, and it is an aggregate SCOREBOARD (counts
 * pinned exactly over a 2000-layout corpus) rather than a correctness test —
 * a mutant it kills is one the properties beside it should have killed on
 * their own. `text-wrapping-quality.test.ts` is the same instrument for
 * wrapping. Excluding both is what makes the lane finish; the mutants they
 * would have caught still have to be caught by something, which is exactly
 * the report this lane exists to produce.
 *
 * `tidy-quality.test.ts` is the same KIND of instrument and is deliberately
 * NOT excluded, because it costs about a second — and because it is the only
 * thing in the repo that can kill its file's mutants at all. Measured:
 * `tidy.ts` sat at 52.63% with every correctness test green, since forcing
 * the overlap axis to one direction leaves the result separated, on-grid,
 * idempotent and deterministic while dragging boxes 50% further. Adding the
 * scoreboard took it to 80.70%. A cheap scoreboard belongs in the lane; an
 * expensive one is what these two exclusions are about.
 */
export default defineConfig({
  test: {
    name: 'canvas-render-node',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/**/*.browser.test.ts',
      'src/layout/edges/edge-routing-quality.test.ts',
      'src/layout/text-wrapping-quality.test.ts',
    ],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
