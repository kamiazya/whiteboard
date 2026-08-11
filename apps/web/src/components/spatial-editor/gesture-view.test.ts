// The shared gesture-view derivations: what a gesture carries, how the
// canvas looks at the live preview geometry, and which edge sides stay
// frozen — ONE producer for the editor's static-base/ghost/live-edge
// layers instead of per-gesture copies drifting apart.
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { Scene } from '@kamiazya/whiteboard-canvas-render'
import { describe, expect, it } from 'vitest'
import { carriedByGesture, frozenSidesOf, liveNodesFor } from './gesture-view.js'
import type { GestureState } from './gestures.js'

const canvas: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 100, y: 100, width: 120, height: 60, text: 'A' },
    { id: 'b', type: 'text', x: 400, y: 100, width: 120, height: 60, text: 'B' },
    { id: 'g', type: 'group', x: 80, y: 80, width: 200, height: 120 },
  ],
  edges: [{ id: 'e1', fromNode: 'a', toNode: 'b' }],
}

const notLocked = () => false

describe('carriedByGesture', () => {
  it("a move carries the grabbed node, extras, and a grabbed frame's members", () => {
    const moving: GestureState = {
      kind: 'moving',
      nodeId: 'g',
      startType: 'group',
      startX: 80,
      startY: 80,
      startPoint: { x: 0, y: 0 },
    }
    const carried = carriedByGesture(canvas, moving, new Set(['b']), notLocked)
    expect(carried).toEqual(new Set(['g', 'b', 'a']))
  })

  it('a resize carries exactly the resized node', () => {
    const resizing: GestureState = {
      kind: 'resizing',
      nodeId: 'a',
      startType: 'text',
      handle: 'e',
      startPoint: { x: 0, y: 0 },
      startBox: { x: 100, y: 100, width: 120, height: 60 },
    }
    expect(carriedByGesture(canvas, resizing, new Set(['b']), notLocked)).toEqual(new Set(['a']))
  })

  it('non-transforming gestures carry nothing', () => {
    expect(carriedByGesture(canvas, { kind: 'idle' }, new Set(), notLocked)).toEqual(new Set())
  })
})

describe('liveNodesFor', () => {
  it('a move translates every carried node by the preview delta', () => {
    const moving: GestureState = {
      kind: 'moving',
      nodeId: 'a',
      startType: 'text',
      startX: 100,
      startY: 100,
      startPoint: { x: 0, y: 0 },
    }
    const live = liveNodesFor(
      canvas,
      moving,
      { x: 150, y: 130, width: 120, height: 60 },
      new Set(['a', 'b']),
    )
    expect(live.find((n) => n.id === 'a')).toMatchObject({ x: 150, y: 130 })
    expect(live.find((n) => n.id === 'b')).toMatchObject({ x: 450, y: 130 })
    expect(live.find((n) => n.id === 'g')).toMatchObject({ x: 80, y: 80 })
  })

  it('a resize reshapes exactly the resized node to the preview box', () => {
    const resizing: GestureState = {
      kind: 'resizing',
      nodeId: 'a',
      startType: 'text',
      handle: 'e',
      startPoint: { x: 0, y: 0 },
      startBox: { x: 100, y: 100, width: 120, height: 60 },
    }
    const live = liveNodesFor(
      canvas,
      resizing,
      { x: 100, y: 100, width: 220, height: 90 },
      new Set(['a']),
    )
    expect(live.find((n) => n.id === 'a')).toMatchObject({ width: 220, height: 90 })
    expect(live.find((n) => n.id === 'b')).toMatchObject({ x: 400 })
  })
})

describe('frozenSidesOf', () => {
  it("collects each committed edge's resolved sides by id", () => {
    const scene: Scene = {
      nodes: [
        { kind: 'shape', bbox: { x: 0, y: 0, w: 10, h: 10 } },
        {
          kind: 'edge',
          id: 'e1',
          path: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          fromSide: 'bottom',
          toSide: 'left',
          fromEnd: 'none',
          toEnd: 'arrow',
        },
      ],
    }
    expect(frozenSidesOf(scene)).toEqual(new Map([['e1', { fromSide: 'bottom', toSide: 'left' }]]))
  })
})
