// What is JSON-Canvas-SPECIFIC about this projection.
//
// The ledger's four directions, the comparison against what a strict export
// really drops, and the round trip are all in `codecs.property.test.ts` now —
// asked of every registered format instead of written once per format, because
// a second projection is exactly where a per-format guard starts being copied
// rather than generalised.
import { describe, expect, it } from 'vitest'
import { fromJsonCanvas, toJsonCanvas } from './projection.js'

describe('the wire trip canonicalises exactly one thing', () => {
  it('drops an extension object with nothing in it rather than emitting it', () => {
    // A canonicalisation, not a loss: `x-whiteboard: {}` says what its absence
    // says. It is the one place the trip normalises instead of preserving, so
    // it is pinned by example rather than left to a property.
    const bare = toJsonCanvas({ nodes: [], edges: [] })
    expect(bare).not.toHaveProperty('x-whiteboard')
    expect(fromJsonCanvas({ nodes: [], edges: [], 'x-whiteboard': {} })).toEqual({
      nodes: [],
      edges: [],
    })
  })
})
