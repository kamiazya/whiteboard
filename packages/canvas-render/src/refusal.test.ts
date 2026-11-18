import { describe, expect, it } from 'vitest'
import { refusalCopy } from './refusal.js'

/** Every class the core refuses a layout with, each owed words of its own. */
const REFUSAL_REASONS = [
  'too-many-elements',
  'referenced-elements',
  'bodies',
  'too-large',
  'comments',
  'proposals',
  'fragments',
  'non-finite',
  'host-measure',
  'core-unavailable',
] as const

describe('refusalCopy', () => {
  it('names what happened and what the reader can do, per reason the core refuses with', () => {
    for (const reason of REFUSAL_REASONS) {
      const code =
        reason === 'non-finite' || reason === 'host-measure' || reason === 'core-unavailable'
          ? 'malformed'
          : 'input-too-large'
      const { title, detail } = refusalCopy({ code, reason })
      expect(title.length, reason).toBeGreaterThan(0)
      // A sentence that says what was refused, then one that says what to do.
      expect(detail.split('. ').length, `${reason}: ${detail}`).toBeGreaterThanOrEqual(2)
      expect(detail, reason).toMatch(/\.$/)
      // No internal vocabulary reaches a reader.
      expect(`${title} ${detail}`, reason).not.toMatch(/core|wasm|rust|layout|refus|cap\b/i)
    }
    const distinct = new Set(
      REFUSAL_REASONS.map((reason) => refusalCopy({ code: 'input-too-large', reason }).detail),
    )
    expect(distinct.size).toBe(REFUSAL_REASONS.length)
  })

  it('answers a reason it has no words for with the general one, not with the reason', () => {
    const unknown = refusalCopy({ code: 'input-too-large', reason: 'font-families' })
    expect(unknown.detail).not.toContain('font-families')
    expect(unknown).toEqual(refusalCopy({ code: 'input-too-large', reason: 'not-a-reason' }))
    const malformed = refusalCopy({ code: 'malformed', reason: 'not-a-reason' })
    expect(malformed.title).not.toBe(unknown.title)
  })
})
