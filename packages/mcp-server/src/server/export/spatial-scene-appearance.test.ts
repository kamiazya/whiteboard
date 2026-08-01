import type { SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { EXPORT_APPEARANCE } from './spatial-scene-appearance.js'

function node(type: SpatialNode['type'], overrides: Partial<SpatialNode> = {}): SpatialNode {
  return {
    id: 'n1',
    type,
    x: 0,
    y: 0,
    width: 40,
    height: 20,
    text: '',
    ...overrides,
  } as SpatialNode
}

describe('EXPORT_APPEARANCE', () => {
  it('resolves text node chrome to white fill with a light gray stroke', () => {
    const resolved = EXPORT_APPEARANCE.resolveNode(node('text'))
    expect(resolved.appearance).toEqual({ fill: '#ffffff', stroke: '#d0d0d0', strokeWidth: 1 })
  })

  it('resolves file node chrome to a distinct light gray fill', () => {
    const resolved = EXPORT_APPEARANCE.resolveNode(node('file'))
    expect(resolved.appearance).toEqual({ fill: '#f5f5f5', stroke: '#c0c0c0', strokeWidth: 1 })
  })

  it('resolves link node chrome to a distinct pale blue fill', () => {
    const resolved = EXPORT_APPEARANCE.resolveNode(node('link'))
    expect(resolved.appearance).toEqual({ fill: '#eef4ff', stroke: '#a9c6ff', strokeWidth: 1 })
  })

  it('resolves group node chrome as unfilled, preserving the no-occlusion invariant', () => {
    // A filled group rect emitted in document order alongside a member node
    // would risk painting over/under it depending on emission order —
    // `fill: 'none'` removes the z-order question entirely. A future edit
    // that gives group a fill must not pass silently.
    const resolved = EXPORT_APPEARANCE.resolveNode(node('group'))
    expect(resolved.appearance).toEqual({ fill: 'none', stroke: '#b0b0b0', strokeWidth: 1 })
  })

  it('applies the same corner radius to every node kind', () => {
    for (const kind of ['text', 'file', 'link', 'group'] as const) {
      expect(EXPORT_APPEARANCE.resolveNode(node(kind)).radius).toBe(4)
    }
  })

  it('resolves every edge to the fixed gray stroke regardless of authored color', () => {
    expect(EXPORT_APPEARANCE.resolveEdge({ id: 'e1', fromNode: 'a', toNode: 'b' })).toEqual({
      stroke: '#606060',
      strokeWidth: 1.5,
    })
    expect(
      EXPORT_APPEARANCE.resolveEdge({ id: 'e1', fromNode: 'a', toNode: 'b', color: '1' }),
    ).toEqual({ stroke: '#606060', strokeWidth: 1.5 })
  })

  it('resolves the label appearance to dark gray sans-serif', () => {
    expect(EXPORT_APPEARANCE.resolveLabel()).toEqual({ fill: '#303030', fontFamily: 'sans-serif' })
  })

  it('exposes the fixed geometry constants used by the layout seam', () => {
    expect(EXPORT_APPEARANCE.paddingPx).toBe(8)
    expect(EXPORT_APPEARANCE.labelFontSizePx).toBe(14)
    expect(EXPORT_APPEARANCE.minContentWidthPx).toBe(1)
  })
})
