// What is JSON-Canvas-SPECIFIC about this projection.
//
// The ledger's four directions, the comparison against what a strict export
// really drops, and the round trip are all in `codecs.property.test.ts` now —
// asked of every registered format instead of written once per format, because
// a second projection is exactly where a per-format guard starts being copied
// rather than generalised.
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
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

describe("an embed node's tags", () => {
  // The embed arm of a node's extension is built apart from the plain arm, and
  // the shared fixture's tagged node is not an embed, so the ledger position
  // is occupied without this arm ever being asked for it.
  it('ride the embed arm of x-whiteboard and come back on the node', () => {
    const node = {
      ...textNode({ id: 'a', x: 0, y: 0, width: 10, height: 10, text: 'a' }),
      embed: { documentId: '01M231FG6BGKKWW4BAA6Z1C945' },
      tags: ['phase:design'],
    }
    const wire = toJsonCanvas({ nodes: [node], edges: [] })

    expect(wire.nodes[0]?.['x-whiteboard']).toMatchObject({ kind: 'embed', tags: ['phase:design'] })
    expect(fromJsonCanvas(wire).nodes[0]?.tags).toEqual(['phase:design'])
  })
})

/**
 * `JSON.stringify(-0)` is `"0"` and `JSON.parse` never yields `-0`, so a
 * projection that emits one writes a value the very next read cannot return.
 * `roundPixel` already says this for the coordinates it rounds; a line's are
 * NOT rounded — ink is sub-pixel by nature and that is what ADR-0037 widened
 * the model for — so they need the normalisation on its own. `-0` and `0` are
 * the same point, so this is a canonicalisation of the same kind as the empty
 * extension above, not a loss.
 *
 * Pinned by example as well as by the round-trip property that found it: the
 * generator reaches `-0` on some seeds and not others, so the property alone
 * would let the fix rot silently on a green run.
 */
describe('a coordinate the wire cannot carry back', () => {
  const lineWith = (x: number, y: number) => ({
    nodes: [],
    edges: [],
    lines: [
      {
        id: 'l1',
        from: { kind: 'point' as const, point: { x, y } },
        to: { kind: 'node' as const, node: 'n1' },
        bends: [{ x, y }],
      },
    ],
  })

  it('normalises a negative zero in a line point end and in a line bend', () => {
    const line = toJsonCanvas(lineWith(-0, -0))['x-whiteboard']?.lines?.[0]
    const from = line?.from
    expect(Object.is(from?.kind === 'point' ? from.point.x : undefined, 0)).toBe(true)
    expect(Object.is(from?.kind === 'point' ? from.point.y : undefined, 0)).toBe(true)
    expect(Object.is(line?.bends?.[0]?.x, 0)).toBe(true)
    expect(Object.is(line?.bends?.[0]?.y, 0)).toBe(true)
  })

  it('leaves a sub-pixel line coordinate alone — only the zero is normalised', () => {
    const line = toJsonCanvas(lineWith(1.25, -2.5))['x-whiteboard']?.lines?.[0]
    expect(line?.bends?.[0]).toEqual({ x: 1.25, y: -2.5 })
  })
})
