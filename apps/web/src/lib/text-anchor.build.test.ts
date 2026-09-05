// The anchor a reader's selection becomes, written from the body at that
// moment: what it quotes must be what `resolveTextAnchor` finds again in
// the same body, at the same place — the two halves of one contract.
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { resolveTextAnchor, textAnchorAt } from './text-anchor.js'

describe('textAnchorAt', () => {
  it('quotes the passage with its surroundings, and names the node when given one', () => {
    const body = 'ship the plan by friday'
    expect(textAnchorAt(body, 9, 13, 'n1')).toEqual({
      kind: 'text',
      nodeId: 'n1',
      quote: { prefix: 'ship the ', exact: 'plan', suffix: ' by friday' },
      start: 9,
      end: 13,
    })
    // At the body's edges there is nothing to quote around, and the
    // schema's optional fields stay absent rather than empty.
    expect(textAnchorAt(body, 0, 4).quote).toEqual({ exact: 'ship', suffix: ' the plan by friday' })
  })

  fcTest.prop(
    [fc.string({ minLength: 1, maxLength: 200 }), fc.nat({ max: 199 }), fc.nat({ max: 199 })],
    withDefaults(),
  )('resolves back to the range it was written from', (body, a, b) => {
    const from = Math.min(a, b) % body.length
    const to = Math.min(body.length, from + 1 + (Math.max(a, b) % 40))
    const anchor = textAnchorAt(body, from, to)
    expect(resolveTextAnchor(body, anchor)).toEqual({ kind: 'placed', start: from, end: to })
  })
})
