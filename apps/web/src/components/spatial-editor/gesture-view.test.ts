// @vitest-environment node
// The shared gesture-view derivations: what a gesture carries, how the
// canvas looks at the live preview geometry, and which edge sides stay
// frozen — ONE producer for the editor's static-base/ghost/live-edge
// layers instead of per-gesture copies drifting apart.

import type { Scene } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import {
  CARRIED_RESIDE_STEP_PX,
  canReuseCarriedSides,
  carriedByGesture,
  carriedSideCacheKey,
  frozenSidesOf,
  ghostCommentObstacles,
  liveNodesFor,
} from './gesture-view.js'
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

describe('ghostCommentObstacles', () => {
  /** A committed scene holding two comment bubbles and one node shape. */
  function committed(): Scene {
    return {
      nodes: [
        { kind: 'shape', id: 'a', bbox: { x: 100, y: 100, w: 120, h: 60 } },
        {
          kind: 'shape',
          id: 'rides/bubble',
          commentChrome: true,
          bbox: { x: 234, y: 174, w: 180, h: 40 },
        },
        {
          kind: 'shape',
          id: 'stays/bubble',
          commentChrome: true,
          bbox: { x: 500, y: 300, w: 180, h: 40 },
        },
      ],
    }
  }

  const withComments: SpatialCanvas = {
    ...canvas,
    'x-whiteboard': {
      comments: [
        { id: 'rides', x: 220, y: 160, text: 'on the carried node', targetNodeId: 'a' },
        { id: 'stays', x: 486, y: 286, text: 'on the bystander', targetNodeId: 'b' },
      ],
    },
  }

  it('leaves out the bubble of a comment that rides the ghost', () => {
    // The ghost re-places that comment's bubble, and its own committed
    // bubble covers the very quadrant the committed placement chose — so
    // counting it flips the ghost to another quadrant at the press, which
    // is the jump the obstacle set exists to prevent.
    const boxes = ghostCommentObstacles(withComments, committed(), new Set(['a']))
    expect(boxes).not.toContainEqual({ x: 234, y: 174, w: 180, h: 40 })
  })

  it('keeps a bystander comment\u2019s bubble, and every node staying behind', () => {
    const boxes = ghostCommentObstacles(withComments, committed(), new Set(['a']))
    expect(boxes).toContainEqual({ x: 500, y: 300, w: 180, h: 40 })
    expect(boxes).toContainEqual({ x: 400, y: 100, w: 120, h: 60 })
    // The carried node travels with the ghost; it is not something to avoid.
    expect(boxes).not.toContainEqual({ x: 100, y: 100, w: 120, h: 60 })
  })

  it('counts a free-floating comment as a bystander: it has no node to ride', () => {
    const free: SpatialCanvas = {
      ...canvas,
      'x-whiteboard': { comments: [{ id: 'rides', x: 220, y: 160, text: 'anchored to a spot' }] },
    }
    expect(ghostCommentObstacles(free, committed(), new Set(['a']))).toContainEqual({
      x: 234,
      y: 174,
      w: 180,
      h: 40,
    })
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

describe('carried side cache', () => {
  const sides = new Map([['e1', { fromSide: 'top', toSide: 'top' } as const]])

  it('reuses within the re-side step for the same carried set', () => {
    const cache = { key: 'e1', anchorX: 100, anchorY: 100, sides }
    expect(canReuseCarriedSides(cache, 'e1', 108, 100)).toBe(true)
  })

  it('recomputes once the carried node has travelled a full step', () => {
    const cache = { key: 'e1', anchorX: 100, anchorY: 100, sides }
    expect(canReuseCarriedSides(cache, 'e1', 100 + CARRIED_RESIDE_STEP_PX, 100)).toBe(false)
  })

  it('never reuses across a different carried-edge set or an empty cache', () => {
    const cache = { key: 'e1', anchorX: 100, anchorY: 100, sides }
    expect(canReuseCarriedSides(cache, 'e1 e2', 100, 100)).toBe(false)
    expect(canReuseCarriedSides(null, 'e1', 100, 100)).toBe(false)
  })

  it('keys are order-independent over the carried edge ids', () => {
    expect(carriedSideCacheKey(new Set(['b', 'a']))).toBe(carriedSideCacheKey(new Set(['a', 'b'])))
  })
})
