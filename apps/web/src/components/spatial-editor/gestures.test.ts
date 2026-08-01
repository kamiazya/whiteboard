import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it } from 'vitest'
import { createIdleState, reduceGesture } from './gestures.js'

function canvas(): SpatialCanvas {
  return {
    nodes: [{ id: 'a', type: 'text', x: 10, y: 10, width: 100, height: 50, text: 'hi' }],
    edges: [],
  }
}

describe('gesture reducer', () => {
  it('a zero-delta drag emits a select, not a move-node command', () => {
    const c = canvas()
    const down = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    expect(down.selectedId).toBe('a')
    const up = reduceGesture(down.state, c, { type: 'pointerup', point: { x: 50, y: 30 } })
    expect(up.state.kind).toBe('idle')
    expect(up.command).toBeUndefined()
  })

  it('a drag on a selected node commits a move-node with the delta applied', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    result = reduceGesture(result.state, c, {
      type: 'pointermove',
      point: { x: 70, y: 45 },
    })
    result = reduceGesture(result.state, c, { type: 'pointerup', point: { x: 70, y: 45 } })
    expect(result.command).toEqual({ kind: 'move-node', id: 'a', x: 30, y: 25 })
    expect(result.state.kind).toBe('idle')
  })

  it('pointercancel always returns to idle with no command', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    result = reduceGesture(result.state, c, { type: 'pointermove', point: { x: 90, y: 90 } })
    result = reduceGesture(result.state, c, { type: 'pointercancel' })
    expect(result.state.kind).toBe('idle')
    expect(result.command).toBeUndefined()
  })

  it('aborts cleanly when the target node vanishes mid-drag (canvas-replaced)', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    const replaced: SpatialCanvas = { nodes: [], edges: [] }
    result = reduceGesture(result.state, c, { type: 'canvas-replaced', canvas: replaced })
    expect(result.state.kind).toBe('idle')
    expect(result.command).toBeUndefined()
  })

  it('aborts cleanly when the target node type changes mid-drag', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    const replaced: SpatialCanvas = {
      nodes: [{ id: 'a', type: 'file', x: 10, y: 10, width: 100, height: 50, file: 'x.png' }],
      edges: [],
    }
    result = reduceGesture(result.state, c, { type: 'canvas-replaced', canvas: replaced })
    expect(result.state.kind).toBe('idle')
    expect(result.command).toBeUndefined()
  })

  it('commits from the gesture start snapshot when the node moved remotely mid-drag', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown',
      nodeId: 'a',
      point: { x: 50, y: 30 },
    })
    result = reduceGesture(result.state, c, { type: 'pointermove', point: { x: 70, y: 45 } })
    const remote: SpatialCanvas = {
      nodes: [{ id: 'a', type: 'text', x: 999, y: 999, width: 100, height: 50, text: 'hi' }],
      edges: [],
    }
    result = reduceGesture(result.state, remote, { type: 'canvas-replaced', canvas: remote })
    result = reduceGesture(result.state, remote, { type: 'pointerup', point: { x: 70, y: 45 } })
    // start node was at (10, 10); delta is (20, 15) -> commits 30, 25, NOT 999-based
    expect(result.command).toEqual({ kind: 'move-node', id: 'a', x: 30, y: 25 })
  })

  it('is total over arbitrary pointerup/pointercancel without a prior pointerdown', () => {
    const c = canvas()
    const state = createIdleState()
    expect(() =>
      reduceGesture(state, c, { type: 'pointerup', point: { x: 0, y: 0 } }),
    ).not.toThrow()
    expect(() => reduceGesture(state, c, { type: 'pointercancel' })).not.toThrow()
  })
})

describe('resize gesture', () => {
  it('dragging the se (max-side) handle grows width/height, opposite corner fixed', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'a',
      handle: 'se',
      point: { x: 110, y: 60 },
      box: { x: 10, y: 10, width: 100, height: 50 },
    })
    result = reduceGesture(result.state, c, {
      type: 'pointerup',
      point: { x: 130, y: 90 },
    })
    // se: width/height grow by the delta, x/y (the nw corner) stay fixed.
    expect(result.command).toEqual({
      kind: 'resize-node',
      id: 'a',
      x: 10,
      y: 10,
      width: 120,
      height: 80,
    })
    expect(result.state.kind).toBe('idle')
  })

  it('dragging the nw (min-side) handle shrinks the box and shifts x/y, opposite corner fixed', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'a',
      handle: 'nw',
      point: { x: 10, y: 10 },
      box: { x: 10, y: 10, width: 100, height: 50 },
    })
    result = reduceGesture(result.state, c, {
      type: 'pointerup',
      point: { x: 30, y: 20 },
    })
    // nw: dragging inward shrinks width/height and moves x/y by the same
    // delta, so the se corner (x + width, y + height) stays fixed at (110, 60).
    expect(result.command).toEqual({
      kind: 'resize-node',
      id: 'a',
      x: 30,
      y: 20,
      width: 80,
      height: 40,
    })
    expect(result.state.kind).toBe('idle')
  })

  it('a zero-delta resize handle drag emits no command', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'a',
      handle: 'se',
      point: { x: 110, y: 60 },
      box: { x: 10, y: 10, width: 100, height: 50 },
    })
    result = reduceGesture(result.state, c, {
      type: 'pointerup',
      point: { x: 110, y: 60 },
    })
    expect(result.command).toBeUndefined()
    expect(result.state.kind).toBe('idle')
  })

  it('overshooting a min-side handle past the box floor-clamps size and keeps the opposite corner fixed', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-handle',
      nodeId: 'a',
      handle: 'nw',
      point: { x: 10, y: 10 },
      box: { x: 10, y: 10, width: 100, height: 50 },
    })
    // Drag the nw handle 200px right/down — far past the box's own 100x50
    // size. Naively unclamped, x/y would land at 210/210, dragging the
    // opposite (se) corner along with it instead of leaving it fixed.
    result = reduceGesture(result.state, c, {
      type: 'pointerup',
      point: { x: 210, y: 210 },
    })
    expect(result.command).toEqual({
      kind: 'resize-node',
      id: 'a',
      x: 110,
      y: 60,
      width: 0,
      height: 0,
    })
    expect(result.state.kind).toBe('idle')
  })
})

describe('connect gesture', () => {
  it('dragging from the connect handle onto another node emits connect-nodes', () => {
    const c: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'text', x: 10, y: 10, width: 100, height: 50, text: 'hi' },
        { id: 'b', type: 'text', x: 200, y: 10, width: 100, height: 50, text: 'bye' },
      ],
      edges: [],
    }
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-connect',
      nodeId: 'a',
    })
    expect(result.state).toEqual({ kind: 'connecting', fromNodeId: 'a' })
    result = reduceGesture(
      result.state,
      c,
      { type: 'pointerup', point: { x: 250, y: 30 }, targetNodeId: 'b' },
      { createEdgeId: () => 'edge-1' },
    )
    expect(result.command).toEqual({
      kind: 'connect-nodes',
      edgeId: 'edge-1',
      fromNode: 'a',
      toNode: 'b',
    })
    expect(result.state.kind).toBe('idle')
  })

  it('dropping a connect drag with no target under the pointer emits no command', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-connect',
      nodeId: 'a',
    })
    result = reduceGesture(result.state, c, { type: 'pointerup', point: { x: 500, y: 500 } })
    expect(result.command).toBeUndefined()
    expect(result.state.kind).toBe('idle')
  })

  it('dropping a connect drag back onto its own source node is a no-op (self-connection guard)', () => {
    const c = canvas()
    let result = reduceGesture(createIdleState(), c, {
      type: 'pointerdown-connect',
      nodeId: 'a',
    })
    result = reduceGesture(result.state, c, {
      type: 'pointerup',
      point: { x: 50, y: 30 },
      targetNodeId: 'a',
    })
    expect(result.command).toBeUndefined()
    expect(result.state.kind).toBe('idle')
  })
})

describe('text-edit gesture', () => {
  it('start-text-edit enters editing-text state for the given node', () => {
    const c = canvas()
    const result = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    expect(result.state).toEqual({ kind: 'editing-text', nodeId: 'a', pendingText: 'hi' })
    expect(result.command).toBeUndefined()
  })

  it('commit-text-edit emits set-text and returns to idle', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const result = reduceGesture(editing.state, c, {
      type: 'commit-text-edit',
      text: 'updated',
    })
    expect(result.command).toEqual({ kind: 'set-text', id: 'a', text: 'updated' })
    expect(result.state.kind).toBe('idle')
  })

  it('a pointerdown on a different node while a text edit is open commits the pending text', () => {
    const c: SpatialCanvas = {
      nodes: [
        { id: 'a', type: 'text', x: 10, y: 10, width: 100, height: 50, text: 'hi' },
        { id: 'b', type: 'text', x: 200, y: 10, width: 100, height: 50, text: 'bye' },
      ],
      edges: [],
    }
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const updated = reduceGesture(editing.state, c, { type: 'update-text-edit', text: 'edited' })
    const result = reduceGesture(updated.state, c, {
      type: 'pointerdown',
      nodeId: 'b',
      point: { x: 250, y: 30 },
    })
    expect(result.command).toEqual({ kind: 'set-text', id: 'a', text: 'edited' })
    expect(result.state.kind).toBe('moving')
    expect(result.selectedId).toBe('b')
  })

  it('commit-text-edit outside editing-text state is a no-op', () => {
    const c = canvas()
    const result = reduceGesture(createIdleState(), c, {
      type: 'commit-text-edit',
      text: 'updated',
    })
    expect(result.command).toBeUndefined()
    expect(result.state.kind).toBe('idle')
  })

  it('cancel-text-edit discards the edit and returns to idle with no command', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const result = reduceGesture(editing.state, c, { type: 'cancel-text-edit' })
    expect(result.state.kind).toBe('idle')
    expect(result.command).toBeUndefined()
  })

  it('aborts an in-flight text edit when the node type changes mid-edit (canvas-replaced)', () => {
    const c = canvas()
    const editing = reduceGesture(createIdleState(), c, {
      type: 'start-text-edit',
      nodeId: 'a',
      text: 'hi',
    })
    const replaced: SpatialCanvas = {
      nodes: [{ id: 'a', type: 'file', x: 10, y: 10, width: 100, height: 50, file: 'x.png' }],
      edges: [],
    }
    const result = reduceGesture(editing.state, c, { type: 'canvas-replaced', canvas: replaced })
    expect(result.state.kind).toBe('idle')
    expect(result.command).toBeUndefined()
  })
})
