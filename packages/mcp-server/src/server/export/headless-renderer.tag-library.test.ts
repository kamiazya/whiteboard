// The daemon's export draws the same picture `wb_scene_render` does for a
// board under a tag library (ADR-0040 decision 5): a box carrying a declared
// value and no colour of its own is painted in that colour, and the legend
// names the key. Through the real renderer, because the option is threaded
// through two functions the mocked export test cannot see.
import { SPATIAL_LIGHT_PALETTE } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { renderSpatialCanvasToSvg } from './headless-renderer.js'

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'api', x: 0, y: 0, width: 160, height: 64, text: 'api', tags: ['health:ok'] }),
    textNode({
      id: 'db',
      x: 240,
      y: 0,
      width: 160,
      height: 64,
      text: 'db',
      tags: ['health:failing'],
    }),
  ],
  edges: [],
}
const library: TagLibrary = {
  health: { exclusive: true, values: { ok: { color: '4' }, failing: { color: '1' } } },
}

describe('export under a tag library', () => {
  it('paints a tagged box in its declared colour and lists the key in the legend', async () => {
    const { svg } = await renderSpatialCanvasToSvg(canvas, { tagLibrary: library })
    expect(svg).toContain(`fill="${SPATIAL_LIGHT_PALETTE.presets['4'].fill}"`)
    expect(svg).toContain(`fill="${SPATIAL_LIGHT_PALETTE.presets['1'].fill}"`)
    expect(svg).toContain('data-wb-legend')
    expect(svg).toContain('health')
  })

  it('draws the board as stored without one', async () => {
    const { svg } = await renderSpatialCanvasToSvg(canvas)
    expect(svg).not.toContain(`fill="${SPATIAL_LIGHT_PALETTE.presets['4'].fill}"`)
    expect(svg).not.toContain('data-wb-legend')
  })
})
