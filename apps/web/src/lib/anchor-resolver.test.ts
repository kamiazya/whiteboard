import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { anchorResolverFor } from './anchor-resolver.js'

const canvas: SpatialCanvas = {
  nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'ship the plan' }],
  edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n1' }],
}
const resolve = anchorResolverFor({ kind: 'spatial', canvas }) as NonNullable<
  ReturnType<typeof anchorResolverFor>
>
const at = (anchor: Parameters<typeof resolve>[0]['anchor']) => resolve({ anchor })

describe('anchorResolverFor on a canvas', () => {
  it('judges a node reference, an edge reference, and leaves a bare point placed', () => {
    expect(at({ kind: 'spatial', nodeId: 'n1', x: 0, y: 0 })).toBe('placed')
    expect(at({ kind: 'spatial', nodeId: 'gone', x: 0, y: 0 })).toBe('orphaned')
    expect(at({ kind: 'spatial', edgeId: 'e1', x: 0, y: 0 })).toBe('placed')
    expect(at({ kind: 'spatial', edgeId: 'gone', x: 0, y: 0 })).toBe('orphaned')
    expect(at({ kind: 'spatial', x: 0, y: 0 })).toBe('placed')
  })

  it('places a node set while any member lives, a region always, and the document always', () => {
    const rect = { x: 0, y: 0, width: 5, height: 5 }
    expect(at({ kind: 'spatial', nodeIds: ['n1', 'gone'], ...rect })).toBe('placed')
    expect(at({ kind: 'spatial', nodeIds: ['gone', 'gone-too'], ...rect })).toBe('orphaned')
    expect(at({ kind: 'spatial', ...rect })).toBe('placed')
    expect(at({ kind: 'document' })).toBe('placed')
  })

  it("judges a passage of a node's text against that node, and its node's presence", () => {
    const quote = { exact: 'plan' }
    expect(at({ kind: 'text', nodeId: 'n1', quote, start: 9, end: 13 })).toBe('placed')
    expect(at({ kind: 'text', nodeId: 'n1', quote: { exact: 'friday' }, start: 0, end: 6 })).toBe(
      'orphaned',
    )
    expect(at({ kind: 'text', nodeId: 'gone', quote, start: 9, end: 13 })).toBe('orphaned')
    // A note's passage is about a surface the canvas does not have.
    expect(at({ kind: 'text', quote, start: 9, end: 13 })).toBe('placed')
  })
})

describe('anchorResolverFor on a note', () => {
  it('answers nothing until the body has loaded, then judges passages only', () => {
    expect(anchorResolverFor({ kind: 'markdown', body: null })).toBeUndefined()
    const note = anchorResolverFor({ kind: 'markdown', body: 'ship the plan' }) as NonNullable<
      ReturnType<typeof anchorResolverFor>
    >
    expect(note({ anchor: { kind: 'text', quote: { exact: 'plan' }, start: 9, end: 13 } })).toBe(
      'placed',
    )
    expect(note({ anchor: { kind: 'text', quote: { exact: 'gone' }, start: 0, end: 4 } })).toBe(
      'orphaned',
    )
    expect(note({ anchor: { kind: 'spatial', nodeId: 'n1', x: 0, y: 0 } })).toBe('placed')
    expect(
      note({ anchor: { kind: 'text', nodeId: 'n1', quote: { exact: 'gone' }, start: 0, end: 4 } }),
    ).toBe('placed')
  })
})
