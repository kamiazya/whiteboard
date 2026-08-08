import { describe, expect, it } from 'vitest'
import type { ListBlockNode, Scene, ShapeSceneNode, TextRunNode } from '../scene-graph.js'
import { scaleScene } from './scale-scene.js'

const run = (over?: Partial<TextRunNode>): TextRunNode => ({
  kind: 'textRun',
  bbox: { x: 10, y: 20, w: 100, h: 16 },
  text: 'hello',
  baseline: 12,
  appearance: { fontSize: 16, strokeWidth: 2, fill: '#111111' },
  ...over,
})

describe('scaleScene', () => {
  it('scales bboxes, baselines, paths, radius, and size-bearing appearance uniformly', () => {
    const scene: Scene = {
      nodes: [
        run(),
        {
          kind: 'shape',
          bbox: { x: 0, y: 0, w: 200, h: 100 },
          radius: 8,
          appearance: { stroke: '#222222', strokeWidth: 1 },
        } satisfies ShapeSceneNode,
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 100, y: 50 },
          ],
          fromSide: 'right',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'arrow',
          appearance: { stroke: '#333333', strokeWidth: 2 },
        },
      ],
    }
    const half = scaleScene(scene, 0.5)

    const scaledRun = half.nodes[0] as TextRunNode
    expect(scaledRun.bbox).toEqual({ x: 5, y: 10, w: 50, h: 8 })
    expect(scaledRun.baseline).toBe(6)
    expect(scaledRun.appearance).toEqual({ fontSize: 8, strokeWidth: 1, fill: '#111111' })

    const scaledShape = half.nodes[1] as ShapeSceneNode
    expect(scaledShape.bbox).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    expect(scaledShape.radius).toBe(4)
    expect(scaledShape.appearance?.strokeWidth).toBe(0.5)

    const scaledEdge = half.nodes[2]
    if (scaledEdge.kind !== 'edge') throw new Error('edge expected')
    expect(scaledEdge.path).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 25 },
    ])
  })

  it('scales wrapper-relative children by the same factor (uniform scaling commutes with the x-transform boundary)', () => {
    // listItem children store x RELATIVE to the wrapper; uniform scaling
    // about the origin scales wrapper offset and relative offset alike, so
    // absolute positions still land at factor * original.
    const list: ListBlockNode = {
      kind: 'list',
      bbox: { x: 20, y: 0, w: 200, h: 40 },
      ordered: false,
      depth: 0,
      items: [
        {
          kind: 'listItem',
          bbox: { x: 20, y: 0, w: 200, h: 20 },
          children: [run({ bbox: { x: 8, y: 0, w: 100, h: 16 } })],
        },
      ],
    }
    const scaled = scaleScene({ nodes: [list] }, 2)
    const scaledList = scaled.nodes[0] as ListBlockNode
    const item = scaledList.items[0]
    expect(item.bbox.x).toBe(40)
    const child = item.children[0] as TextRunNode
    // Relative x scales too: absolute = 40 (wrapper transform) + 16 = 56 = 2 * (20 + 8).
    expect(child.bbox.x).toBe(16)
  })

  it('factor 1 is the identity and degenerate factors return the scene unchanged (total, never throws)', () => {
    const scene: Scene = { nodes: [run()] }
    expect(scaleScene(scene, 1)).toEqual(scene)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(scaleScene(scene, bad)).toBe(scene)
    }
  })

  it('leaves svgFragment content verbatim while scaling its bbox (documented limitation)', () => {
    const scene: Scene = {
      nodes: [
        {
          kind: 'svgFragment',
          bbox: { x: 10, y: 10, w: 40, h: 20 },
          svg: '<g><text>x</text></g>',
        },
      ],
    }
    const scaled = scaleScene(scene, 0.5)
    const fragment = scaled.nodes[0]
    if (fragment.kind !== 'svgFragment') throw new Error('fragment expected')
    expect(fragment.bbox).toEqual({ x: 5, y: 5, w: 20, h: 10 })
    expect(fragment.svg).toBe('<g><text>x</text></g>')
  })
})
