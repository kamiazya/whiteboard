import { describe, expect, it } from 'vitest'
import { computeDragPreview, isInFlightGesture } from './drag-preview.js'
import type { NodeBox } from './geometry.js'
import type { GestureState } from './gestures.js'

const idle: GestureState = { kind: 'idle' }

function movingState(overrides: Partial<Extract<GestureState, { kind: 'moving' }>> = {}) {
  const state: GestureState = {
    kind: 'moving',
    nodeId: 'n1',
    startType: 'text',
    startPoint: { x: 100, y: 100 },
    startX: 10,
    startY: 20,
    ...overrides,
  }
  return state
}

function resizingState(overrides: Partial<Extract<GestureState, { kind: 'resizing' }>> = {}) {
  const state: GestureState = {
    kind: 'resizing',
    nodeId: 'n1',
    startType: 'text',
    handle: 'se',
    startPoint: { x: 100, y: 100 },
    startBox: { x: 0, y: 0, width: 200, height: 100 },
    ...overrides,
  }
  return state
}

function connectingState(overrides: Partial<Extract<GestureState, { kind: 'connecting' }>> = {}) {
  const state: GestureState = { kind: 'connecting', fromNodeId: 'n1', ...overrides }
  return state
}

describe('computeDragPreview — moving', () => {
  it('yields a box at (startX+dx, startY+dy) with the node committed width/height', () => {
    const boxes: readonly NodeBox[] = [{ id: 'n1', box: { x: 10, y: 20, width: 200, height: 80 } }]
    const state = movingState()
    const preview = computeDragPreview(state, boxes, { x: 130, y: 90 })
    expect(preview).toEqual({
      kind: 'box',
      box: { x: 10 + 30, y: 20 + -10, width: 200, height: 80 },
    })
  })

  it('returns undefined when the gesture target id is absent from boxes (deleted mid-drag)', () => {
    const state = movingState()
    const preview = computeDragPreview(state, [], { x: 130, y: 90 })
    expect(preview).toBeUndefined()
  })
})

describe('computeDragPreview — resizing', () => {
  it('yields exactly resizeBoxByDelta(startBox, handle, dx, dy)', () => {
    const state = resizingState()
    const preview = computeDragPreview(state, [], { x: 150, y: 160 })
    expect(preview).toEqual({ kind: 'box', box: { x: 0, y: 0, width: 250, height: 160 } })
  })

  it('never produces NaN geometry for a zero-delta drag', () => {
    const state = resizingState()
    const preview = computeDragPreview(state, [], state.startPoint)
    expect(preview).toEqual({ kind: 'box', box: state.startBox })
  })

  it('produces finite geometry for a zero-size start box', () => {
    const state = resizingState({ startBox: { x: 5, y: 5, width: 0, height: 0 } })
    const preview = computeDragPreview(state, [], { x: 20, y: 12 })
    expect(preview?.kind).toBe('box')
    if (preview?.kind !== 'box') throw new Error('expected box preview')
    expect(Number.isFinite(preview.box.width)).toBe(true)
    expect(Number.isFinite(preview.box.height)).toBe(true)
  })
})

describe('computeDragPreview — connecting', () => {
  it('yields a line from the source box centre to the live point', () => {
    const boxes: readonly NodeBox[] = [{ id: 'n1', box: { x: 0, y: 0, width: 100, height: 50 } }]
    const state = connectingState()
    const preview = computeDragPreview(state, boxes, { x: 300, y: 400 })
    expect(preview).toEqual({ kind: 'line', from: { x: 50, y: 25 }, to: { x: 300, y: 400 } })
  })

  it('returns undefined when the fromNode id is absent from boxes', () => {
    const state = connectingState()
    const preview = computeDragPreview(state, [], { x: 300, y: 400 })
    expect(preview).toBeUndefined()
  })
})

describe('computeDragPreview — totality on degenerate states', () => {
  it('returns undefined for idle', () => {
    expect(computeDragPreview(idle, [], { x: 1, y: 1 })).toBeUndefined()
  })

  it('returns undefined for editing-text', () => {
    const state: GestureState = { kind: 'editing-text', nodeId: 'n1', pendingText: 'x' }
    expect(computeDragPreview(state, [], { x: 1, y: 1 })).toBeUndefined()
  })

  it('returns undefined when livePoint is null, regardless of gesture kind', () => {
    expect(computeDragPreview(movingState(), [], null)).toBeUndefined()
    expect(computeDragPreview(resizingState(), [], null)).toBeUndefined()
    expect(computeDragPreview(connectingState(), [], null)).toBeUndefined()
  })
})

describe('isInFlightGesture', () => {
  it('is true for moving/resizing/connecting and false otherwise', () => {
    expect(isInFlightGesture(movingState())).toBe(true)
    expect(isInFlightGesture(resizingState())).toBe(true)
    expect(isInFlightGesture(connectingState())).toBe(true)
    expect(isInFlightGesture(idle)).toBe(false)
    expect(isInFlightGesture({ kind: 'editing-text', nodeId: 'n1', pendingText: '' })).toBe(false)
  })
})
