// @vitest-environment node
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { indexNodeBoxes } from '../../lib/spatial/geometry.js'
import { snapGesturePoint } from './gesture-snap.js'
import type { GestureState } from './gestures.js'

function textNode(id: string, x: number, y: number, width = 100, height = 50) {
  return { id, type: 'text' as const, text: '', x, y, width, height }
}

function inputsFor(
  canvas: SpatialCanvas,
  gestureState: GestureState,
  extraIds: ReadonlySet<string> = new Set(),
) {
  return {
    gestureState,
    canvas,
    boxes: indexNodeBoxes(canvas),
    extraIds,
    isLocked: () => false,
    zoom: 1,
  }
}

const movingB: GestureState = {
  kind: 'moving',
  nodeId: 'b',
  startType: 'text',
  startPoint: { x: 350, y: 30 },
  startX: 300,
  startY: 7,
}

describe('snapGesturePoint', () => {
  it('suspended → raw point, no guides, whatever the gesture', () => {
    const canvas: SpatialCanvas = { nodes: [textNode('a', 0, 0), textNode('b', 300, 7)], edges: [] }
    const out = snapGesturePoint({ x: 152.5, y: 30 }, true, inputsFor(canvas, movingB))
    expect(out).toEqual({ point: { x: 152.5, y: 30 }, guides: { x: [], y: [] } })
  })

  it('idle (non-snapping) gesture → passthrough', () => {
    const canvas: SpatialCanvas = { nodes: [textNode('a', 0, 0)], edges: [] }
    const out = snapGesturePoint({ x: 5, y: 5 }, false, inputsFor(canvas, { kind: 'idle' }))
    expect(out).toEqual({ point: { x: 5, y: 5 }, guides: { x: [], y: [] } })
  })

  it('moving near a neighbour edge nudges the POINTER by the snap delta and emits the guide', () => {
    // Dragging b so its leading edge lands at 102.5 — within the 6px
    // threshold of a's trailing edge at 100. The y axis has nothing in
    // range (nearest line is 7 away), pinning that axes snap independently.
    const canvas: SpatialCanvas = { nodes: [textNode('a', 0, 0), textNode('b', 300, 7)], edges: [] }
    const out = snapGesturePoint({ x: 152.5, y: 30 }, false, inputsFor(canvas, movingB))
    expect(out).toEqual({ point: { x: 150, y: 30 }, guides: { x: [100], y: [] } })
  })

  it('a multi-selection member travelling with the drag stops attracting it (no edge guide)', () => {
    // a's trailing edge sits at 103 (off the 20px grid). Alone it wins the
    // snap with a guide; carried with the drag it is excluded, and only the
    // guideless grid line at 100 remains in range.
    const canvas: SpatialCanvas = { nodes: [textNode('a', 3, 0), textNode('b', 300, 7)], edges: [] }
    const free = snapGesturePoint({ x: 155, y: 30 }, false, inputsFor(canvas, movingB))
    expect(free.guides.x).toEqual([103])
    const carried = snapGesturePoint(
      { x: 155, y: 30 },
      false,
      inputsFor(canvas, movingB, new Set(['a'])),
    )
    expect(carried.guides).toEqual({ x: [], y: [] })
    expect(carried.point.x).toBe(150) // grid line at 100: 155 + (100 - 105)
  })

  it('resizing snaps only the edge under the handle, never the anchored axis', () => {
    const canvas: SpatialCanvas = {
      nodes: [textNode('a', 410, 0), textNode('b', 300, 0)],
      edges: [],
    }
    const resizingB: GestureState = {
      kind: 'resizing',
      nodeId: 'b',
      startType: 'text',
      handle: 'e',
      startPoint: { x: 400, y: 25 },
      startBox: { x: 300, y: 0, width: 100, height: 50 },
    }
    const out = snapGesturePoint({ x: 407, y: 25 }, false, inputsFor(canvas, resizingB))
    expect(out).toEqual({ point: { x: 410, y: 25 }, guides: { x: [410], y: [] } })
  })
})
