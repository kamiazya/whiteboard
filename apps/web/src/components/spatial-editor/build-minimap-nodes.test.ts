import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { indexNodeBoxes } from './geometry.js'
import { buildMinimapNodes } from './SpatialEditor.js'

function nodes(entries: SpatialCanvas['nodes']): SpatialCanvas['nodes'] {
  return entries
}

describe('buildMinimapNodes', () => {
  it('passes an authored hex color through unchanged', () => {
    const n = nodes([
      { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi', color: '#ff0000' },
    ])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(buildMinimapNodes(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
      { x: 0, y: 0, width: 100, height: 50, color: '#ff0000' },
    ])
  })

  it('resolves a preset key through the palette presets stroke', () => {
    const n = nodes([
      { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi', color: '3' },
    ])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(buildMinimapNodes(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
      { x: 0, y: 0, width: 100, height: 50, color: SPATIAL_LIGHT_PALETTE.presets['3'].stroke },
    ])
  })

  it('leaves an unstyled node with no color', () => {
    const n = nodes([{ id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi' }])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(buildMinimapNodes(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
      { x: 0, y: 0, width: 100, height: 50, color: undefined },
    ])
  })

  it('maps every box, in order, over a mixed set of nodes', () => {
    const n = nodes([
      { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a', color: '#00ff00' },
      { id: 'b', type: 'file', x: 20, y: 0, width: 10, height: 10, file: 'b.png' },
      {
        id: 'c',
        type: 'text',
        x: 40,
        y: 0,
        width: 10,
        height: 10,
        text: 'c',
        color: '1',
      },
    ])
    const boxes = indexNodeBoxes({ nodes: n, edges: [] })
    expect(buildMinimapNodes(n, boxes, SPATIAL_LIGHT_PALETTE)).toEqual([
      { x: 0, y: 0, width: 10, height: 10, color: '#00ff00' },
      { x: 20, y: 0, width: 10, height: 10, color: undefined },
      { x: 40, y: 0, width: 10, height: 10, color: SPATIAL_LIGHT_PALETTE.presets['1'].stroke },
    ])
  })
})
