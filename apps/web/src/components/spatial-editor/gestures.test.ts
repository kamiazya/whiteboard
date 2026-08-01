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
