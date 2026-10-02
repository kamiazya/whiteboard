import { workspaceSegmentSchema } from '@kamiazya/whiteboard-model'
import { fc, withDefaults } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { firstFreeSegment } from './first-free-segment.js'

const takenBy = (...taken: string[]) => {
  const set = new Set(taken)
  return (segment: string) => set.has(segment)
}

describe('firstFreeSegment', () => {
  it('answers the base itself when nobody holds it', async () => {
    expect(await firstFreeSegment('design-team', takenBy())).toBe('design-team')
  })

  it('starts counting at 2, because the unsuffixed segment is the first one', async () => {
    expect(await firstFreeSegment('design-team', takenBy('design-team'))).toBe('design-team-2')
  })

  it('takes the lowest free suffix, not the one after the highest held', async () => {
    const taken = takenBy('notes', 'notes-3')
    expect(await firstFreeSegment('notes', taken)).toBe('notes-2')
  })

  it('accepts a predicate that answers asynchronously', async () => {
    const held = new Set(['notes', 'notes-2'])
    expect(await firstFreeSegment('notes', async (segment) => held.has(segment))).toBe('notes-3')
  })

  it('answers nothing once a thousand are held, leaving the canonical id to address it', async () => {
    expect(await firstFreeSegment('notes', () => true)).toBeUndefined()
  })

  it('answers nothing when a suffix would push the segment out of its grammar', async () => {
    // A base the grammar already refuses grows into candidates it refuses too;
    // an address nothing validated is one the resolver rejects somewhere less obvious.
    expect(await firstFreeSegment('-', takenBy('-'))).toBeUndefined()
  })
})

/** Candidate `n` of a series: the base, then `base-2`, `base-3`, ... */
const candidate = (base: string, n: number) => (n === 1 ? base : `${base}-${n}`)

const baseArbitrary = fc.oneof(
  fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,5}[a-z0-9])?$/),
  fc.string({ maxLength: 6 }),
  fc.constantFrom('', '-', 'a-', '-a', 'a b'),
)

/** Which of the first dozen candidates are held — dense enough that holes and full runs both occur. */
const heldArbitrary = fc.oneof(
  fc.uniqueArray(fc.integer({ min: 1, max: 12 })),
  fc.integer({ min: 0, max: 12 }).map((count) => Array.from({ length: count }, (_, i) => i + 1)),
)

describe('firstFreeSegment (property)', () => {
  it('answers a segment that is free, valid, and the lowest of its series', async () => {
    await fc.assert(
      fc.asyncProperty(baseArbitrary, heldArbitrary, async (base, held) => {
        const taken = new Set(held.map((n) => candidate(base, n)))
        const result = await firstFreeSegment(base, (segment) => taken.has(segment))
        if (result === undefined) {
          // Refusal is only right when every candidate up to the first one the
          // grammar rejects is held — here that is the first dozen at most.
          for (let n = 1; n <= 12; n++) {
            const next = candidate(base, n)
            if (n > 1 && !workspaceSegmentSchema.safeParse(next).success) return
            expect(taken.has(next), `${next} was free yet nothing was answered`).toBe(true)
          }
          return
        }
        expect(taken.has(result)).toBe(false)
        const n = result === base ? 1 : Number(result.slice(base.length + 1))
        expect(candidate(base, n)).toBe(result)
        if (n > 1) expect(workspaceSegmentSchema.safeParse(result).success).toBe(true)
        for (let lower = 1; lower < n; lower++) {
          expect(taken.has(candidate(base, lower)), `${candidate(base, lower)} was free`).toBe(true)
        }
      }),
      withDefaults(),
    )
  })
})
