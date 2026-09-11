// @vitest-environment node
//
// Dragging a bend on an edge. The overlay decides WHICH point is being
// moved and hands the reducer the list it should end up with; the reducer
// only moves that one by the pointer's delta. That split is what lets a
// bend be ADDED by the same gesture — a ghost handle on a straight run
// dispatches the list with the new point already inserted.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { createIdleState, reduceGesture } from './gestures.js'

const board = (bends?: { x: number; y: number }[]): SpatialCanvas => ({
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' },
    { id: 'b', type: 'text', x: 400, y: 0, width: 100, height: 50, text: 'b' },
  ],
  edges: [
    {
      id: 'e',
      from: { kind: 'node' as const, node: 'a' },
      to: { kind: 'node' as const, node: 'b' },
      ...(bends === undefined ? {} : { bends }),
    },
  ],
})

const drag = (
  canvas: SpatialCanvas,
  down: { edgeId: string; index: number; waypoints: readonly { x: number; y: number }[] },
  from: { x: number; y: number },
  to: { x: number; y: number },
) => {
  let result = reduceGesture(createIdleState(), canvas, {
    type: 'pointerdown-bend',
    edgeId: down.edgeId,
    index: down.index,
    waypoints: down.waypoints,
    point: from,
  })
  result = reduceGesture(result.state, canvas, { type: 'pointermove', point: to })
  return reduceGesture(result.state, canvas, { type: 'pointerup', point: to })
}

describe('dragging a bend', () => {
  it('moves the named point by the pointer delta and leaves the others alone', () => {
    const stored = [
      { x: 100, y: 200 },
      { x: 300, y: 200 },
    ]
    const result = drag(
      board(stored),
      { edgeId: 'e', index: 1, waypoints: stored },
      { x: 300, y: 200 },
      { x: 340, y: 260 },
    )
    expect(result.commands).toEqual([
      {
        kind: 'set-edge-bends',
        id: 'e',
        bends: [
          { x: 100, y: 200 },
          { x: 340, y: 260 },
        ],
      },
    ])
  })

  it('adds a bend when the list it is handed carries one the edge does not', () => {
    // The ghost handle's whole mechanism: an edge with no bends is dragged
    // by a point inserted at the run's midpoint.
    const result = drag(
      board(),
      { edgeId: 'e', index: 0, waypoints: [{ x: 250, y: 25 }] },
      { x: 250, y: 25 },
      { x: 250, y: 180 },
    )
    expect(result.commands).toEqual([
      { kind: 'set-edge-bends', id: 'e', bends: [{ x: 250, y: 180 }] },
    ])
  })

  it('rounds to whole units, the way a node position is rounded', () => {
    const result = drag(
      board(),
      { edgeId: 'e', index: 0, waypoints: [{ x: 250, y: 25 }] },
      { x: 250.4, y: 25.4 },
      { x: 250.9, y: 180.6 },
    )
    expect(result.commands[0]).toMatchObject({ bends: [{ x: 251, y: 180 }] })
  })

  it('commits nothing when the pointer never moved, so a stray click stores no bend', () => {
    const result = drag(
      board(),
      { edgeId: 'e', index: 0, waypoints: [{ x: 250, y: 25 }] },
      { x: 250, y: 25 },
      { x: 250, y: 25 },
    )
    expect(result.commands).toEqual([])
    expect(result.state.kind).toBe('idle')
  })

  it('removes the field outright when the last bend is dragged away', () => {
    // An empty list is how set-edge-bends says "no bends", and an edge with
    // none takes a computed route again — the model refuses an empty array
    // for exactly that reason: absence already says it.
    const result = reduceGesture(createIdleState(), board([{ x: 250, y: 180 }]), {
      type: 'remove-bend',
      edgeId: 'e',
      index: 0,
    })
    expect(result.commands).toEqual([{ kind: 'set-edge-bends', id: 'e', bends: [] }])
  })

  it('keeps the rest when one bend of several is removed', () => {
    const result = reduceGesture(
      createIdleState(),
      board([
        { x: 100, y: 200 },
        { x: 300, y: 200 },
      ]),
      { type: 'remove-bend', edgeId: 'e', index: 0 },
    )
    expect(result.commands).toEqual([
      { kind: 'set-edge-bends', id: 'e', bends: [{ x: 300, y: 200 }] },
    ])
  })

  it('aborts the drag when the edge leaves the canvas under it', () => {
    const stored = [{ x: 250, y: 180 }]
    const down = reduceGesture(createIdleState(), board(stored), {
      type: 'pointerdown-bend',
      edgeId: 'e',
      index: 0,
      waypoints: stored,
      point: { x: 250, y: 180 },
    })
    const gone: SpatialCanvas = { ...board(stored), edges: [] }
    const replaced = reduceGesture(down.state, gone, {
      type: 'canvas-replaced',
      canvas: gone,
      origin: 'external',
    })
    expect(replaced.state.kind).toBe('idle')
    expect(replaced.commands).toEqual([])
  })
})
