// @vitest-environment node
// The reducer arms behind the ink drag, where the browser test cannot see
// them: what arms the gesture, what it refuses, and what the release writes.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { createIdleState, reduceGesture } from './gestures.js'

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'a' })],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'a' } }],
  lines: [
    {
      id: 'l1',
      from: { kind: 'point', point: { x: 10, y: 10 } },
      to: { kind: 'point', point: { x: 90, y: 90 } },
    },
    {
      id: 'l2',
      from: { kind: 'point', point: { x: 20, y: 20 } },
      to: { kind: 'point', point: { x: 80, y: 80 } },
    },
  ],
}

const armAt = (ids: readonly string[], x: number, y: number) =>
  reduceGesture(createIdleState(), canvas, {
    type: 'pointerdown-ink',
    ids,
    point: { x, y },
  })

describe('arming an ink drag', () => {
  it('takes every stroke it was handed', () => {
    const armed = armAt(['l1', 'l2'], 50, 50)
    expect(armed.state).toEqual({
      kind: 'moving-ink',
      ids: ['l1', 'l2'],
      startPoint: { x: 50, y: 50 },
    })
  })

  it('drops a RELATION, and arms nothing when that is all there was', () => {
    // An edge's path is routed from the boxes it joins, so it has no
    // geometry of its own to move. Dropping it HERE rather than at the
    // release is what lets the press fall through to the band it always
    // started — a gesture armed over nothing would have swallowed it.
    expect(armAt(['e1'], 50, 50).state.kind).toBe('idle')
    expect(armAt(['e1', 'l1'], 50, 50).state).toMatchObject({ ids: ['l1'] })
  })

  it('arms nothing for an id the canvas does not hold', () => {
    expect(armAt(['gone'], 50, 50).state.kind).toBe('idle')
  })
})

describe('releasing one', () => {
  const release = (ids: readonly string[], to: { x: number; y: number }) =>
    reduceGesture({ kind: 'moving-ink', ids, startPoint: { x: 50, y: 50 } }, canvas, {
      type: 'pointerup',
      point: to,
    })

  it('writes ONE batch, so a dragged scribble undoes as one step', () => {
    const result = release(['l1', 'l2'], { x: 70, y: 40 })
    expect(result.commands).toEqual([
      {
        kind: 'batch',
        commands: [
          { kind: 'move-line', id: 'l1', dx: 20, dy: -10 },
          { kind: 'move-line', id: 'l2', dx: 20, dy: -10 },
        ],
      },
    ])
    expect(result.state.kind).toBe('idle')
  })

  it('writes nothing when the pointer never travelled', () => {
    // What keeps a plain press on ink a plain selection: the same rule the
    // bend drag keeps for its ghost handle.
    expect(release(['l1'], { x: 50, y: 50 }).commands).toEqual([])
  })

  it('writes nothing when every stroke went while the pointer was down', () => {
    expect(release(['gone'], { x: 70, y: 40 }).commands).toEqual([])
  })
})
