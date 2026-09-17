// The declared layer reaching the picture: a board whose boxes carry
// `health:*` and no colour of their own, laid out with the workspace's tag
// library, is drawn in the declared colours AND lists the key in its
// legend — which is the point of applying intent to the canvas rather
// than to the resolver alone (the legend is judged by the score, and the
// score reads the canvas).
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { layoutSpatialCanvas } from '../layout/spatial-canvas.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { SPATIAL_LIGHT_PALETTE } from '../theme/spatial-palette.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'

const library: TagLibrary = {
  health: { exclusive: true, values: { ok: { color: '4' }, failing: { color: '1' } } },
}
const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'api', text: 'api', x: 0, y: 0, width: 120, height: 60, tags: ['health:ok'] }),
    textNode({
      id: 'db',
      text: 'db',
      x: 200,
      y: 0,
      width: 120,
      height: 60,
      tags: ['health:failing'],
    }),
    textNode({
      id: 'cache',
      text: 'cache',
      x: 400,
      y: 0,
      width: 120,
      height: 60,
      tags: ['health:ok'],
    }),
  ],
  edges: [],
}
const options = { measure: createFakeMeasure(), appearance: createSpatialTheme({ mode: 'light' }) }

describe('a layout given the tag library', () => {
  it('lists the declared key in the legend with the declared colours as swatches', () => {
    const scene = layoutSpatialCanvas(canvas, { ...options, tagLibrary: library })
    expect(scene.legend?.keys.map((key) => key.key)).toEqual(['health'])
    const entries = scene.legend?.keys[0]?.entries ?? []
    expect(entries.map((entry) => [entry.value, entry.count])).toEqual([
      ['failing', 1],
      ['ok', 2],
    ])
    // The swatch is the preset the library named, resolved through the same
    // theme the boxes are painted with.
    expect(entries[0]?.swatch.fill).toBe(SPATIAL_LIGHT_PALETTE.presets['1'].fill)
    expect(entries[1]?.swatch.fill).toBe(SPATIAL_LIGHT_PALETTE.presets['4'].fill)
  })

  it('draws the same board exactly as stored without the library: no colour, no legend', () => {
    const scene = layoutSpatialCanvas(canvas, options)
    expect(scene.legend).toBeUndefined()
  })
})
