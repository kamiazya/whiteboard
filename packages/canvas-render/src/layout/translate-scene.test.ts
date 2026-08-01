import type {
  ListBlockNode,
  ListItemNode,
  ParagraphBlockNode,
  Scene,
  TableBlockNode,
} from '../scene-graph.js'
import { renderSceneToSvg } from '../svg/backend.js'
import { translateScene } from './translate-scene.js'
import { describe, expect, it } from 'vitest'

function paragraphScene(): Scene {
  return {
    nodes: [
      {
        kind: 'paragraph',
        bbox: { x: 0, y: 0, w: 100, h: 20 },
        runs: [{ kind: 'textRun', bbox: { x: 0, y: 16, w: 40, h: 20 }, text: 'hi' }],
      },
    ],
  }
}

function listScene(): Scene {
  const item: ListItemNode = {
    kind: 'listItem',
    bbox: { x: 24, y: 0, w: 76, h: 20 },
    children: [
      {
        kind: 'paragraph',
        bbox: { x: 0, y: 0, w: 76, h: 20 },
        runs: [{ kind: 'textRun', bbox: { x: 0, y: 16, w: 20, h: 20 }, text: 'a' }],
      },
    ],
  }
  const list: ListBlockNode = {
    kind: 'list',
    bbox: { x: 0, y: 0, w: 100, h: 20 },
    ordered: false,
    depth: 0,
    items: [item],
  }
  return { nodes: [list] }
}

describe('translateScene', () => {
  it('is the identity when translated by (0, 0)', () => {
    const scene = paragraphScene()
    expect(translateScene(scene, 0, 0)).toEqual(scene)
  })

  it('shifts a flat scene bbox by (dx, dy)', () => {
    const scene = paragraphScene()
    const shifted = translateScene(scene, 5, 7)
    expect((shifted.nodes[0] as ParagraphBlockNode).bbox).toEqual({ x: 5, y: 7, w: 100, h: 20 })
  })

  it('shifts a listItem wrapper on x but leaves its descendants wrapper-relative x untouched', () => {
    const scene = listScene()
    const shifted = translateScene(scene, 10, 0)
    const list = shifted.nodes[0] as ListBlockNode
    const item = list.items[0]!
    expect(item.bbox.x).toBe(24 + 10)
    const paragraph = item.children[0]! as ParagraphBlockNode
    expect(paragraph.bbox.x).toBe(0) // unchanged: relative to the item's own transform
  })

  it('composes additively: translate(translate(s,a,b),c,d) === translate(s,a+c,b+d)', () => {
    const scene = listScene()
    const twice = translateScene(translateScene(scene, 3, 4), 5, 6)
    const once = translateScene(scene, 8, 10)
    expect(twice).toEqual(once)
  })

  it('produces the correct final drawn x through the SVG backend (no double-shift)', () => {
    const scene = listScene()
    const dx = 50
    const baseline = renderSceneToSvg(scene)
    const shifted = renderSceneToSvg(translateScene(scene, dx, 0))

    // The listItem wrapper's own transform must shift by exactly dx.
    const baselineTransform = baseline.match(/transform="translate\(([-\d.]+),0\)"/)
    const shiftedTransform = shifted.match(/transform="translate\(([-\d.]+),0\)"/)
    expect(Number(shiftedTransform?.[1])).toBeCloseTo(Number(baselineTransform?.[1]) + dx)

    // The nested text run's own x attribute (relative, inside the <g>) is unchanged.
    const baselineText = baseline.match(/<text x="([-\d.]+)"/)
    const shiftedText = shifted.match(/<text x="([-\d.]+)"/)
    expect(Number(shiftedText?.[1])).toBeCloseTo(Number(baselineText?.[1])!)
  })

  it('tripwire: exactly listItem and tableCell emit a transform in the SVG backend', () => {
    const table: TableBlockNode = {
      kind: 'table',
      bbox: { x: 0, y: 0, w: 100, h: 24 },
      rows: [
        {
          kind: 'tableRow',
          bbox: { x: 0, y: 0, w: 100, h: 24 },
          cells: [{ kind: 'tableCell', bbox: { x: 30, y: 0, w: 70, h: 24 }, runs: [] }],
        },
      ],
    }
    const scene = listScene()
    const combined: Scene = { nodes: [...scene.nodes, table] }
    const svg = renderSceneToSvg(combined)
    const transformCount = (svg.match(/transform="translate\(/g) ?? []).length
    // one from the listItem, one from the tableCell — if canvas-render adds
    // a third translating renderer this count changes and this test fails,
    // signalling translateScene's x-rule needs to learn about it too.
    expect(transformCount).toBe(2)
  })
})
