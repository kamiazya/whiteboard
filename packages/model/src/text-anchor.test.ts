import { describe, expect, test } from 'vitest'
import type { TextAnchor } from './annotation.js'
import { resolveTextAnchor } from './text-anchor.js'

function anchorAt(
  body: string,
  exact: string,
  extra: Partial<TextAnchor['quote']> = {},
): TextAnchor {
  const start = body.indexOf(exact)
  return {
    kind: 'text',
    quote: { exact, ...extra },
    start,
    end: start + exact.length,
  }
}

describe('resolveTextAnchor', () => {
  test('the stored offsets hold when nothing moved', () => {
    const body = 'The plan is to ship on Thursday.'
    expect(resolveTextAnchor(body, anchorAt(body, 'Thursday'))).toEqual({
      kind: 'placed',
      start: 23,
      end: 31,
    })
  })

  test('a mark wins outright over the quote', () => {
    const body = 'The plan is to ship on Thursday.'
    expect(resolveTextAnchor(body, anchorAt(body, 'Thursday'), { start: 4, end: 8 })).toEqual({
      kind: 'placed',
      start: 4,
      end: 8,
    })
  })

  test('the only occurrence elsewhere is found after an edit above it', () => {
    const anchor = anchorAt('The plan is to ship on Thursday.', 'Thursday')
    const edited = 'Note. The plan is to ship on Thursday.'
    expect(resolveTextAnchor(edited, anchor)).toEqual({ kind: 'placed', start: 29, end: 37 })
  })

  test('context breaks a tie between several occurrences', () => {
    const body = 'ship on Thursday. We used to ship on Thursday too.'
    // Stale offsets on purpose: while `body.slice(start, end)` is still the
    // quote the resolver stops at branch 1, and the tiebreak this case exists
    // to exercise never runs.
    const anchor: TextAnchor = {
      kind: 'text',
      quote: { prefix: 'used to ship on ', exact: 'Thursday', suffix: ' too' },
      start: 0,
      end: 8,
    }
    expect(resolveTextAnchor(body, anchor)).toEqual({ kind: 'placed', start: 37, end: 45 })
  })

  test('a passage that is gone orphans rather than pointing somewhere else', () => {
    const anchor = anchorAt('The plan is to ship on Thursday.', 'Thursday')
    expect(resolveTextAnchor('The plan changed entirely.', anchor)).toEqual({ kind: 'orphaned' })
  })
})
