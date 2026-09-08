/**
 * The one direction a conflict check must never get wrong.
 *
 * ADR-0029 decision 5 asks whether the passage still reads what the proposal
 * assumed. A false POSITIVE there is friction — somebody re-reads a change
 * they could have adopted. A false NEGATIVE is the failure the decision
 * exists to prevent: an edit applied onto text the proposer was never shown.
 * So the property is one-sided on purpose, and asserts about the answer
 * `false` only.
 *
 * A property rather than examples because the interesting inputs are RANGES,
 * and the trap is a range the body cannot supply. `String.slice` CLAMPS, so
 * such a range returns the body's tail rather than nothing — and a tail that
 * happens to read what was assumed answered "no conflict". Hand-written cases
 * do not reach for a range past the end; a generator does nothing else.
 */
import { describe, expect, it } from 'vitest'
import type { BodyProposedChange } from './proposal.js'
import { bodyChangeConflicts } from './proposal-apply.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

const body = fc.stringMatching(/^[a-d ]{0,30}$/)
/** Deliberately unbounded by the body's length — the out-of-range case IS the subject. */
const offset = fc.integer({ min: 0, max: 40 })

function change(assumed: string): BodyProposedChange {
  return {
    id: 'body:1',
    op: 'body.replace',
    status: 'open',
    anchor: { kind: 'text', quote: { exact: assumed }, start: 0, end: assumed.length },
    text: 'whatever the proposal wanted instead',
    assumed,
  }
}

/**
 * How often the generator actually reached the case this file is about.
 *
 * Without it the property passes just as well over ranges that all happen to
 * fit, which is the vacuous version of it — and vacuous is exactly what the
 * `text-anchor` property was before this same trap was found there.
 */
let outOfRange = 0

describe('bodyChangeConflicts', () => {
  fcTest.prop([body, offset, offset], withDefaults())(
    'answers "no conflict" only on a read the body really has',
    (text, a, b) => {
      const at = { start: Math.min(a, b), end: Math.max(a, b) }
      // `assumed` is the CLAMPED read, which is what makes the case reachable:
      // the pre-fix code compared against exactly this and agreed with itself.
      const assumed = text.slice(at.start, at.end)
      if (at.end > text.length) outOfRange += 1

      if (bodyChangeConflicts(change(assumed), text, at)) return

      // It said the passage still reads what was assumed. Then the range has
      // to be one the body can supply — otherwise the agreement was with a
      // tail `slice` invented.
      expect(at.end).toBeLessThanOrEqual(text.length)
      expect(text.slice(at.start, at.end)).toBe(assumed)
    },
  )

  it('reached the out-of-range case it is about', () => {
    expect(outOfRange).toBeGreaterThan(0)
  })

  fcTest.prop([body, offset, offset])('an absent passage is always a conflict', (text, a, b) => {
    const at = { start: Math.min(a, b), end: Math.max(a, b) }
    expect(bodyChangeConflicts(change(text.slice(at.start, at.end)), text, undefined)).toBe(true)
  })
})
