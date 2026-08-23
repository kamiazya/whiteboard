import { describe, expect, it } from 'vitest'
import {
  isHumanActor,
  normalizeOkfVerified,
  okfActorSchema,
  okfTimestampSchema,
  trustFacetsSchema,
  trustTier,
} from './trust.js'

describe('okfActorSchema (OKF §7)', () => {
  it('accepts all three conventional forms', () => {
    for (const actor of ['reference_agent/gemini-2.5-pro', 'human:ahormati', 'process:nightly']) {
      expect(okfActorSchema.safeParse(actor).success).toBe(true)
    }
  })

  it("accepts a form outside §7's three bullets, because the spec's own examples use one", () => {
    // §5.1 writes `author: team:ga4-docs`. A schema enforcing the three
    // bullets would reject the specification's own sample data.
    expect(okfActorSchema.safeParse('team:ga4-docs').success).toBe(true)
  })

  it('rejects blank, padded and multi-line actors', () => {
    for (const actor of ['', '  ', ' human:a', 'human:a ', 'human:a\nhuman:b']) {
      expect(okfActorSchema.safeParse(actor).success).toBe(false)
    }
  })
})

describe('okfTimestampSchema (OKF §5)', () => {
  it('requires an explicit UTC offset, in either accepted spelling', () => {
    expect(okfTimestampSchema.safeParse('2026-06-20T22:53:05Z').success).toBe(true)
    expect(okfTimestampSchema.safeParse('2026-05-28T22:53:05+00:00').success).toBe(true)
    expect(okfTimestampSchema.safeParse('2026-06-20T22:53:05.123Z').success).toBe(true)
  })

  it('rejects a datetime with no offset and a bare date', () => {
    expect(okfTimestampSchema.safeParse('2026-06-20T22:53:05').success).toBe(false)
    expect(okfTimestampSchema.safeParse('2026-06-20').success).toBe(false)
  })
})

describe('normalizeOkfVerified widens a bare mapping (OKF §5.2 MUST)', () => {
  it('reads a single mapping as a one-element list', () => {
    expect(normalizeOkfVerified({ by: 'human:a', at: '2026-06-25T09:00:00Z' })).toEqual([
      { by: 'human:a', at: '2026-06-25T09:00:00Z' },
    ])
  })

  it('leaves a list alone', () => {
    const events = [
      { by: 'human:a', at: '2026-06-25T09:00:00Z' },
      { by: 'process:nightly', at: '2026-06-26T02:00:00Z' },
    ]
    expect(normalizeOkfVerified(events)).toEqual(events)
  })

  it('passes a value it cannot widen straight through, for the schema to reject', () => {
    expect(normalizeOkfVerified('nope')).toBe('nope')
    expect(normalizeOkfVerified(null)).toBe(null)
  })
})

describe('trustTier is derived, never stored (OKF §5.3)', () => {
  it('no verified key is unverified', () => {
    expect(trustTier(undefined)).toBe('unverified')
    expect(trustTier({})).toBe('unverified')
    expect(trustTier({ verified: [] })).toBe('unverified')
  })

  it('non-human verifiers only is machine-confirmed', () => {
    expect(trustTier({ verified: [{ by: 'process:nightly', at: '2026-06-26T02:00:00Z' }] })).toBe(
      'machine-confirmed',
    )
  })

  it('any human verifier makes it human-reviewed, whatever else is in the list', () => {
    expect(
      trustTier({
        verified: [
          { by: 'process:nightly', at: '2026-06-26T02:00:00Z' },
          { by: 'human:a', at: '2026-06-25T09:00:00Z' },
        ],
      }),
    ).toBe('human-reviewed')
  })

  it('a generated actor is not a verifier, however human it is', () => {
    expect(trustTier({ generated: { by: 'human:a', at: '2026-06-20T22:53:05Z' } })).toBe(
      'unverified',
    )
  })
})

describe('isHumanActor', () => {
  it('keys only off the prefix §5.3 makes load-bearing', () => {
    expect(isHumanActor('human:ahormati')).toBe(true)
    expect(isHumanActor('process:human-review')).toBe(false)
    expect(isHumanActor('agent/human')).toBe(false)
  })
})

describe('trustFacetsSchema', () => {
  it('rejects an unknown sibling rather than storing it in this bucket', () => {
    expect(
      trustFacetsSchema.safeParse({ generated: { by: 'a', at: '2026-06-20T22:53:05Z' }, x: 1 })
        .success,
    ).toBe(false)
  })
})
