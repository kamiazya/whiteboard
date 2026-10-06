// The declared layer reaching the picture: a board whose boxes carry
// `health:*` and no colour of their own, laid out with the workspace's tag
// library, is drawn in the declared colours AND lists the key in its
// legend — which is the point of applying intent to the canvas rather
// than to the resolver alone (the legend is judged by the score, and the
// score reads the canvas).
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { layoutMdastBlocks } from '../layout/markdown-body.js'
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

// A board drawn INSIDE another document is the same board: the box its
// author tagged `health:failing` is red in the miniature as on its own page.
// The legend stays with the host (ADR-0040), so only the fill is asserted.
describe('a canvas drawn inside another document, given the tag library', () => {
  const BOARD = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const failing = SPATIAL_LIGHT_PALETTE.presets['1'].fill
  const resolveReference = (ref: string) => (ref === BOARD ? { canvas } : undefined)

  it('colours a file node miniature the way the board colours itself', () => {
    const host: SpatialCanvas = {
      nodes: [fileNode({ id: 'f', file: BOARD, x: 0, y: 0, width: 800, height: 300 })],
      edges: [],
    }
    const scene = layoutSpatialCanvas(host, {
      ...options,
      tagLibrary: library,
      resolveReference,
      expandFileNode: () => true,
    })
    expect(shapeFills(scene.nodes, 'db')).toEqual([failing])
  })

  it(`colours a text node's ![[board]] the way the board colours itself`, () => {
    const host: SpatialCanvas = {
      nodes: [textNode({ id: 't', text: `![[${BOARD}]]`, x: 0, y: 0, width: 800, height: 400 })],
      edges: [],
    }
    const scene = layoutSpatialCanvas(host, {
      ...options,
      tagLibrary: library,
      resolveEmbed: (id) => (id === BOARD ? { title: 'Board', canvas } : undefined),
    })
    expect(shapeFills(scene.nodes, 'db')).toEqual([failing])
  })

  it(`colours a note's ![[board]] the way the board colours itself`, () => {
    const note: MdastRoot = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'embed', documentId: BOARD }] }],
    }
    const scene = layoutMdastBlocks(note, {
      measure: options.measure,
      maxWidth: 800,
      fontFamily: 'sans-serif',
      tagLibrary: library,
      resolveEmbed: (id) => (id === BOARD ? { title: 'Board', canvas } : undefined),
    })
    expect(shapeFills(scene.nodes, 'db')).toEqual([failing])
  })
})

/** The fills of the chrome drawn for document node `id`, at any nesting depth. */
function shapeFills(nodes: readonly SceneNode[], id: string): (string | undefined)[] {
  return nodes.flatMap((node) => [
    ...(node.kind === 'shape' && node.id === id ? [node.appearance?.fill] : []),
    ...shapeFills((node as { children?: readonly SceneNode[] }).children ?? [], id),
  ])
}
