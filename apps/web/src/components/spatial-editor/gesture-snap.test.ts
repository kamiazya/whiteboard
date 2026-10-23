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

  it('a press that stays under the tap slop pins the pointer to the press point, however near a snap line', () => {
    const canvas: SpatialCanvas = { nodes: [textNode('a', 0, 0), textNode('b', 300, 7)], edges: [] }
    for (const suspended of [false, true]) {
      const out = snapGesturePoint({ x: 352, y: 31 }, suspended, inputsFor(canvas, movingB))
      expect(out).toEqual({ point: movingB.startPoint, guides: { x: [], y: [] } })
    }
  })

  it('the tap slop is measured on screen, so zooming in shrinks it in canvas units', () => {
    const canvas: SpatialCanvas = { nodes: [textNode('a', 0, 0), textNode('b', 300, 7)], edges: [] }
    const out = snapGesturePoint({ x: 352, y: 30 }, true, {
      ...inputsFor(canvas, movingB),
      zoom: 8,
    })
    expect(out.point).toEqual({ x: 352, y: 30 })
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

  it('a bottom-edge resize snaps the trailing edge to a neighbour top edge', () => {
    // b's bottom edge travels 50 -> 207; a's top edge at 210 is 3 away.
    const canvas: SpatialCanvas = {
      nodes: [textNode('a', 600, 210), textNode('b', 300, 0)],
      edges: [],
    }
    const resizingB: GestureState = {
      kind: 'resizing',
      nodeId: 'b',
      startType: 'text',
      handle: 's',
      startPoint: { x: 350, y: 50 },
      startBox: { x: 300, y: 0, width: 100, height: 50 },
    }
    const out = snapGesturePoint({ x: 350, y: 207 }, false, inputsFor(canvas, resizingB))
    expect(out).toEqual({ point: { x: 350, y: 210 }, guides: { x: [], y: [210] } })
  })

  it('a top-edge resize snaps the leading edge, not the bottom one', () => {
    // b's top edge travels 0 -> 213 (its bottom would be 263, out of range).
    const canvas: SpatialCanvas = {
      nodes: [textNode('a', 600, 210), textNode('b', 300, 0)],
      edges: [],
    }
    const resizingB: GestureState = {
      kind: 'resizing',
      nodeId: 'b',
      startType: 'text',
      handle: 'n',
      startPoint: { x: 350, y: 0 },
      startBox: { x: 300, y: 0, width: 100, height: 50 },
    }
    const out = snapGesturePoint({ x: 350, y: 213 }, false, inputsFor(canvas, resizingB))
    expect(out).toEqual({ point: { x: 350, y: 210 }, guides: { x: [], y: [210] } })
  })

  it('a bottom-edge resize leaves x alone even beside a neighbour edge', () => {
    // b's right edge would sit at 395, 5 from a's left edge (and the grid)
    // at 400 — in range, so only the anchored x axis keeps it from snapping.
    const canvas: SpatialCanvas = {
      nodes: [textNode('a', 400, 210), textNode('b', 300, 0)],
      edges: [],
    }
    const resizingB: GestureState = {
      kind: 'resizing',
      nodeId: 'b',
      startType: 'text',
      handle: 's',
      startPoint: { x: 350, y: 50 },
      startBox: { x: 300, y: 0, width: 100, height: 50 },
    }
    const out = snapGesturePoint({ x: 345, y: 207 }, false, inputsFor(canvas, resizingB))
    expect(out).toEqual({ point: { x: 345, y: 210 }, guides: { x: [], y: [210] } })
  })

  it('a move snaps by the moving box’s own size, not a neighbour’s', () => {
    // b (100 wide) lands at 590, so its right edge 690 is 4 from a's left
    // edge at 694. Measured with a's 30 width instead, no line of b is in
    // range and nothing would snap.
    const canvas: SpatialCanvas = {
      nodes: [textNode('a', 694, 300, 30, 30), textNode('b', 300, 7)],
      edges: [],
    }
    const out = snapGesturePoint({ x: 640, y: 30 }, false, inputsFor(canvas, movingB))
    expect(out).toEqual({ point: { x: 644, y: 30 }, guides: { x: [694], y: [] } })
  })
})
