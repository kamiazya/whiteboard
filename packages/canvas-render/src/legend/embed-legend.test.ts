// A board embedded in a note keeps its legend: the coloured boxes inside a
// `![[board]]` mean what the board's key says, and a note printed or
// exported without that key shows colour nobody can read. The legend is
// drawn under the miniature, inside the embed's frame, at its own size —
// the board is shrunk to fit the column and the key must not be.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { SceneNode, TextRunNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { layoutMdastBlocks } from '../layout/markdown-body.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { SPATIAL_LIGHT_PALETTE } from '../theme/spatial-palette.js'
import { LEGEND_FONT_PX } from './legend-geometry.js'

const BOARD = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const library: TagLibrary = {
  health: { exclusive: true, values: { ok: { color: '4' }, failing: { color: '1' } } },
}
const box = (id: string, x: number, tags: readonly string[] = []) =>
  textNode({ id, text: id, x, y: 0, width: 400, height: 200, tags: [...tags] })
// Wide enough that the miniature is scaled well below 1 in a 600px column.
const tagged: SpatialCanvas = {
  nodes: [
    box('api', 0, ['health:ok']),
    box('db', 1000, ['health:failing']),
    box('cache', 2000, ['health:ok']),
  ],
  edges: [],
}
const untagged: SpatialCanvas = { nodes: [box('api', 0), box('db', 1000)], edges: [] }
const body: MdastRoot = {
  type: 'root',
  children: [{ type: 'paragraph', children: [{ type: 'embed', documentId: BOARD }] }],
}

function embedOf(canvas: SpatialCanvas) {
  const scene = layoutMdastBlocks(body, {
    measure: createFakeMeasure(),
    maxWidth: 600,
    fontFamily: 'sans-serif',
    tagLibrary: library,
    resolveEmbed: (id) => (id === BOARD ? { title: 'Board', canvas } : undefined),
  })
  const embed = scene.nodes[0]
  if (embed?.kind !== 'embedResolved') throw new Error('expected an embedResolved block')
  return { embed, frame: embed.children.find((node) => node.kind === 'shape') }
}

const runs = (nodes: readonly SceneNode[]): TextRunNode[] =>
  nodes.filter((node): node is TextRunNode => node.kind === 'textRun')

describe('a board embedded in a note', () => {
  it('draws its legend under the miniature, unscaled, inside the frame', () => {
    const { embed, frame } = embedOf(tagged)
    const legend = runs(embed.children).filter((run) =>
      ['health', 'failing', 'ok'].includes(run.text),
    )
    expect(legend.map((run) => run.text)).toEqual(['health', 'failing', 'ok'])
    for (const run of legend) {
      expect(run.appearance?.fontSize).toBe(LEGEND_FONT_PX)
      // No halo pill: that is for a label over an edge, and boxed every word here.
      expect(run.appearance?.halo).toBeUndefined()
      if (frame === undefined) throw new Error('expected the embed frame')
      expect(run.bbox.y).toBeGreaterThanOrEqual(frame.bbox.y)
      expect(run.bbox.y + run.bbox.h).toBeLessThanOrEqual(frame.bbox.y + frame.bbox.h)
    }
    // Each value's swatch is the colour its boxes are drawn in.
    const swatchFills = embed.children.flatMap((node) =>
      node.kind === 'shape' && node.bbox.w === 16 ? [node.appearance?.fill] : [],
    )
    expect(swatchFills).toEqual([
      SPATIAL_LIGHT_PALETTE.presets['1'].fill,
      SPATIAL_LIGHT_PALETTE.presets['4'].fill,
    ])
  })

  it('draws no key for a board whose colour means nothing', () => {
    const { embed } = embedOf(untagged)
    expect(runs(embed.children).map((run) => run.text)).not.toContain('health')
  })
})
