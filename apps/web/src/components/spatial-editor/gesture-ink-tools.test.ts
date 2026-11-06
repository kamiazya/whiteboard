// @vitest-environment node
import type { CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { reduceGesture } from './gestures.js'

const stroke = (id: string): CanvasLine => ({
  id,
  from: { kind: 'point', point: { x: 0, y: 0 }, end: 'none' },
  to: { kind: 'point', point: { x: 100, y: 0 }, end: 'none' },
})

const O = { x: 0, y: 0 }

const canvas: SpatialCanvas = { nodes: [], edges: [], lines: [stroke('a'), stroke('b')] }

function sweep(...overs: (readonly string[])[]) {
  let state = reduceGesture({ kind: 'idle' }, canvas, {
    type: 'pointerdown-erase',
    point: O,
    ids: [],
  }).state
  for (const ids of overs)
    state = reduceGesture(state, canvas, { type: 'erase-over', point: O, ids }).state
  return state
}

describe('the eraser gesture', () => {
  it('collects each drawing it passes over once, in the order it touched them', () => {
    expect(sweep(['b'], ['a', 'b'], ['b'])).toEqual({ kind: 'erasing', ids: ['b', 'a'], at: O })
  })

  it('removes everything the sweep touched as ONE undoable batch at the release', () => {
    const released = reduceGesture(sweep(['a'], ['b']), canvas, {
      type: 'pointerup',
      point: { x: 0, y: 0 },
    })
    expect(released.state).toEqual({ kind: 'idle' })
    expect(released.commands).toEqual([
      {
        kind: 'batch',
        commands: [
          { kind: 'delete-line', id: 'a' },
          { kind: 'delete-line', id: 'b' },
        ],
      },
    ])
  })

  it('writes nothing for a sweep over empty board', () => {
    const released = reduceGesture(sweep(), canvas, { type: 'pointerup', point: { x: 0, y: 0 } })
    expect(released.commands).toEqual([])
  })

  it('skips a drawing that left the board mid-sweep rather than deleting it again', () => {
    const smaller: SpatialCanvas = { ...canvas, lines: [stroke('b')] }
    const released = reduceGesture(sweep(['a', 'b']), smaller, {
      type: 'pointerup',
      point: { x: 0, y: 0 },
    })
    expect(released.commands).toEqual([
      { kind: 'batch', commands: [{ kind: 'delete-line', id: 'b' }] },
    ])
  })

  it('erases nothing when the sweep is cancelled', () => {
    const cancelled = reduceGesture(sweep(['a']), canvas, { type: 'pointercancel' })
    expect(cancelled.state).toEqual({ kind: 'idle' })
    expect(cancelled.commands).toEqual([])
  })

  it('ignores a sweep event outside an erase', () => {
    const idle = reduceGesture({ kind: 'idle' }, canvas, {
      type: 'erase-over',
      point: O,
      ids: ['a'],
    })
    expect(idle.state).toEqual({ kind: 'idle' })
    expect(idle.commands).toEqual([])
  })
})
