// A locked node cannot be picked or dragged, and nothing in its drawing said
// so. The lock is editor state, not canvas content, so the renderer is told
// WHICH ids are locked (`lockedNodeIds`) and draws the mark; a render given no
// such list — export, the MCP scene — is byte-for-byte what it always was.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { Scene } from '@kamiazya/whiteboard-scene'

type IconSceneNode = Extract<Scene['nodes'][number], { kind: 'icon' }>

import { describe, expect, it } from 'vitest'
import { sceneBounds } from '../scene-bounds.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { layoutSpatialCanvas, type SpatialLayoutOptions } from './spatial-canvas.js'

const APPEARANCE = {
  resolveNode: () => ({ appearance: { stroke: '#445566' } }),
  resolveEdge: () => ({}),
  resolveLabel: () => ({ fill: '#336699' }),
}

function options(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return { measure: createFakeMeasure(), appearance: APPEARANCE, ...over }
}

const NODE = { x: 100, y: 50, width: 200, height: 120 }
const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', ...NODE, text: 'a' }),
    textNode({ id: 'b', x: 400, y: 50, width: 200, height: 120, text: 'b' }),
  ],
  edges: [],
}

const lockIcons = (scene: Scene): readonly IconSceneNode[] =>
  scene.nodes.filter((n): n is IconSceneNode => n.kind === 'icon' && n.icon === 'lock')

describe('the lock badge', () => {
  it('marks a locked node inside its top-right corner, in the theme’s stroke', () => {
    const [badge, ...rest] = lockIcons(
      layoutSpatialCanvas(canvas, options({ lockedNodeIds: ['a'] })),
    )
    expect(rest).toEqual([])
    expect(badge?.bbox.w).toBe(12)
    expect(badge?.bbox.h).toBe(12)
    // Inside the box, against its right and top edges.
    expect(badge!.bbox.x + badge!.bbox.w).toBeLessThanOrEqual(NODE.x + NODE.width)
    expect(badge!.bbox.x + badge!.bbox.w).toBeGreaterThan(NODE.x + NODE.width - 24)
    expect(badge!.bbox.y).toBeGreaterThanOrEqual(NODE.y)
    expect(badge!.bbox.y).toBeLessThan(NODE.y + 12)
    expect(badge?.appearance?.stroke).toBe('#445566')
  })

  it('draws nothing for an unlocked node, or when no locks are given', () => {
    expect(lockIcons(layoutSpatialCanvas(canvas, options()))).toEqual([])
    expect(lockIcons(layoutSpatialCanvas(canvas, options({ lockedNodeIds: ['b'] })))).toHaveLength(
      1,
    )
    expect(lockIcons(layoutSpatialCanvas(canvas, options({ lockedNodeIds: [] })))).toEqual([])
  })

  it('leaves the scene’s bounds where they were', () => {
    const plain = sceneBounds(layoutSpatialCanvas(canvas, options()))
    const locked = sceneBounds(layoutSpatialCanvas(canvas, options({ lockedNodeIds: ['a', 'b'] })))
    expect(locked).toEqual(plain)
  })

  it('moves with the node, carrying no coordinates of its own', () => {
    const moved: SpatialCanvas = {
      nodes: [
        textNode({ id: 'a', x: NODE.x + 37, y: NODE.y - 11, width: 200, height: 120, text: 'a' }),
      ],
      edges: [],
    }
    const at = lockIcons(layoutSpatialCanvas(canvas, options({ lockedNodeIds: ['a'] })))[0]!.bbox
    const after = lockIcons(layoutSpatialCanvas(moved, options({ lockedNodeIds: ['a'] })))[0]!.bbox
    expect(after).toEqual({ ...at, x: at.x + 37, y: at.y - 11 })
  })

  it('is not drawn inside a nested canvas, even when its id collides', () => {
    const inner: SpatialCanvas = {
      nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 60, text: 'inner' })],
      edges: [],
    }
    const host: SpatialCanvas = {
      nodes: [fileNode({ id: 'host', x: 0, y: 0, width: 300, height: 200, file: 'inner.canvas' })],
      edges: [],
    }
    const scene = layoutSpatialCanvas(
      host,
      options({
        lockedNodeIds: ['a'],
        expandFileNode: () => true,
        resolveReference: (ref) => (ref === 'inner.canvas' ? { canvas: inner } : undefined),
      }),
    )
    const flat = JSON.stringify(scene)
    // The miniature really is in the scene, so the absence below is not vacuous.
    expect(flat).toContain('embedResolved')
    expect(flat).toContain('inner')
    expect(flat).not.toContain('"icon":"lock"')
  })
})
