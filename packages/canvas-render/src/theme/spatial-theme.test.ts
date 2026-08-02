import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { SPATIAL_THEME_FONT_FAMILY } from './font-family.js'
import { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from './spatial-palette.js'
import { createSpatialTheme } from './spatial-theme.js'

function textNode(overrides: Partial<Extract<SpatialNode, { type: 'text' }>> = {}): SpatialNode {
  return {
    id: 'n1',
    type: 'text',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    text: 'hello',
    ...overrides,
  }
}

function edge(overrides: Partial<CanvasEdge> = {}): CanvasEdge {
  return { id: 'e1', fromNode: 'a', toNode: 'b', ...overrides }
}

describe('createSpatialTheme', () => {
  it('resolves a JSON Canvas numbered preset color to its approximated hex', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const { appearance } = theme.resolveNode(textNode({ color: '1' }))
    expect(appearance?.fill).toBe('#e03131')
  })

  it('passes through an already-hex node color unchanged', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const { appearance } = theme.resolveNode(textNode({ color: '#abcdef' }))
    expect(appearance?.fill).toBe('#abcdef')
  })

  it('falls back to the palette fill/stroke for a node with no authored color', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const { appearance } = theme.resolveNode(textNode())
    expect(appearance).toEqual({
      fill: SPATIAL_LIGHT_PALETTE.node.text.fill,
      stroke: SPATIAL_LIGHT_PALETTE.node.text.stroke,
    })
  })

  it('falls back to the text style for an unrecognized node type', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const bogus = { ...textNode(), type: 'bogus' } as unknown as SpatialNode
    const { appearance } = theme.resolveNode(bogus)
    expect(appearance).toEqual({
      fill: SPATIAL_LIGHT_PALETTE.node.text.fill,
      stroke: SPATIAL_LIGHT_PALETTE.node.text.stroke,
    })
  })

  it('approximates an ellipse hint radius as half the smaller dimension', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const { radius } = theme.resolveNode(
      textNode({
        width: 200,
        height: 100,
        'x-whiteboard': { kind: 'shape', shape: 'ellipse' },
      }),
    )
    expect(radius).toBe(50)
  })

  it('uses the palette corner radius for a node with no ellipse hint', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    const { radius } = theme.resolveNode(textNode())
    expect(radius).toBe(SPATIAL_LIGHT_PALETTE.cornerRadiusPx)
  })

  it('resolves an edge with no authored color to the palette edge stroke', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    expect(theme.resolveEdge(edge())).toEqual({ stroke: SPATIAL_LIGHT_PALETTE.edgeStroke })
  })

  it('resolves an edge preset color to its approximated hex', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    expect(theme.resolveEdge(edge({ color: '3' }))).toEqual({ stroke: '#f08c00' })
  })

  it('resolves a label to the palette label fill and the shared theme font family', () => {
    const theme = createSpatialTheme({ mode: 'light' })
    expect(theme.resolveLabel()).toEqual({
      fill: SPATIAL_LIGHT_PALETTE.labelFill,
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
    })
  })

  it('resolves node/edge/label colors from the dark palette in dark mode', () => {
    const theme = createSpatialTheme({ mode: 'dark' })
    expect(theme.resolveNode(textNode()).appearance).toEqual({
      fill: SPATIAL_DARK_PALETTE.node.text.fill,
      stroke: SPATIAL_DARK_PALETTE.node.text.stroke,
    })
    expect(theme.resolveEdge(edge())).toEqual({ stroke: SPATIAL_DARK_PALETTE.edgeStroke })
    expect(theme.resolveLabel().fill).toBe(SPATIAL_DARK_PALETTE.labelFill)
  })
})
