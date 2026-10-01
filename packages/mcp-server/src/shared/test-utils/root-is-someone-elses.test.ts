/**
 * Both sides of the skip this probe gates, because a skipped test reads
 * exactly like a passing one in the summary line: the three foreign-owner
 * cases in `data-dir-owner.test.ts` stop running everywhere if it answers
 * `false`, and nothing goes red.
 */
import { describe, expect, it } from 'vitest'
import { assertDataDirOwnedByUser } from '../data-dir-secure.js'
import { ROOT_IS_SOMEONE_ELSES } from './root-is-someone-elses.js'

describe('ROOT_IS_SOMEONE_ELSES', () => {
  it('agrees with whether the owner check actually refuses `/` here', () => {
    let refused: boolean
    try {
      assertDataDirOwnedByUser('/')
      refused = false
    } catch {
      refused = true
    }
    expect(
      refused,
      'the probe and the owner check disagree, so every skip it gates is decided on a stale answer',
    ).toBe(ROOT_IS_SOMEONE_ELSES)
  })

  // The half that stops the skip becoming permanent: CI is the run whose
  // green is load-bearing, and it is an ordinary user over a root-owned `/`.
  it.runIf(process.env.CI)('is true on CI, where the foreign-owner cases must run for real', () => {
    expect(
      ROOT_IS_SOMEONE_ELSES,
      'CI runs as the owner of `/`, so the foreign-owner cases are being skipped there — find out why before trusting this run',
    ).toBe(true)
  })
})
