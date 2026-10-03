import { fc, fcTest } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import strykerVitestConfig from '../../../vitest.stryker.config.js'
import { STRYKER_PROPERTY_SEED } from '../../../vitest.stryker-setup.js'

/**
 * Stryker's vitest runner picks the tests that cover a mutant by TITLE: it
 * records the covering titles on a dry run and re-selects them by name for
 * each mutant. `@fast-check/vitest` writes the run's seed into a property's
 * title, `... (with seed=N)`, with N drawn fresh per process unless fast-check
 * has a global seed — so a property's title in the dry run matches nothing in
 * the mutant runs, and a mutant only the properties could kill is judged by
 * zero tests and reported as a survivor. The setup file pins the seed for this
 * lane alone so titles are stable across processes.
 */
describe('the mutation lane selects property tests by a stable title', () => {
  it('runs the setup file that pins the property seed', () => {
    const setup = strykerVitestConfig.test?.setupFiles
    expect([setup].flat()).toContain('./vitest.stryker-setup.ts')
  })

  // Importing the setup module above is what pins the seed in THIS file's
  // process, so the title is checked without running the lane.
  fcTest.prop([fc.nat()])('a property title carries the pinned seed, not a fresh one', () => {
    expect(expect.getState().currentTestName).toMatch(
      new RegExp(`\\(with seed=${STRYKER_PROPERTY_SEED}\\)$`),
    )
  })
})
