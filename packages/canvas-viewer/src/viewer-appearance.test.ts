import type { SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { VIEWER_APPEARANCE } from './viewer-appearance.js'

function textNode(overrides: Partial<SpatialNode> = {}): SpatialNode {
  return {
    id: 'n1',
    type: 'text',
    x: 0,
    y: 0,
    width: 40,
    height: 20,
    text: '',
    ...overrides,
  } as SpatialNode
}

describe('VIEWER_APPEARANCE', () => {
  it('renders a colorless node as fill:none rather than an invented default fill', () => {
    const resolved = VIEWER_APPEARANCE.resolveNode(textNode())
    expect(resolved.appearance?.fill).toBe('none')
  })

  it('resolves an explicit preset color to its fill instead of none', () => {
    const resolved = VIEWER_APPEARANCE.resolveNode(textNode({ color: '1' }))
    expect(resolved.appearance?.fill).toBe('#e03131')
  })

  it('resolves an explicit hex color verbatim', () => {
    const resolved = VIEWER_APPEARANCE.resolveNode(textNode({ color: '#123456' }))
    expect(resolved.appearance?.fill).toBe('#123456')
  })

  it('honors x-whiteboard ellipse shape as a radius on the shape node', () => {
    const resolved = VIEWER_APPEARANCE.resolveNode(
      textNode({ width: 40, height: 20, 'x-whiteboard': { kind: 'shape', shape: 'ellipse' } }),
    )
    expect(resolved.radius).toBe(10)
  })

  it('approximates a non-square ellipse as a pill shape (known limitation, not a true ellipse)', () => {
    // canvas-render's ShapeSceneNode has no ellipse primitive (deliberately
    // minimal) — mapping ellipse to `radius` is a documented
    // rect-with-corner-radius approximation, exact only for a near-square
    // node. Pinning this so a future radius-formula change doesn't silently
    // alter the approximation without review.
    const resolved = VIEWER_APPEARANCE.resolveNode(
      textNode({ width: 200, height: 60, 'x-whiteboard': { kind: 'shape', shape: 'ellipse' } }),
    )
    expect(resolved.radius).toBe(30)
  })

  it('omits radius for a non-ellipse node', () => {
    const resolved = VIEWER_APPEARANCE.resolveNode(textNode())
    expect(resolved.radius).toBeUndefined()
  })

  it('resolves an edge color to a stroke, or undefined when uncolored', () => {
    expect(
      VIEWER_APPEARANCE.resolveEdge({ id: 'e1', fromNode: 'a', toNode: 'b', color: '1' }),
    ).toEqual({ stroke: '#e03131' })
    expect(VIEWER_APPEARANCE.resolveEdge({ id: 'e1', fromNode: 'a', toNode: 'b' })).toBeUndefined()
  })

  it('resolves the label appearance to the viewer font family', () => {
    expect(VIEWER_APPEARANCE.resolveLabel().fontFamily).toBeDefined()
  })
})
