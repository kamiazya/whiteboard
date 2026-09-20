// @vitest-environment node
// The reducer arms behind an END drag, where the browser test cannot see
// them: what arms it, what a release writes, and the two releases that
// deliberately write nothing.
//
// The asymmetry is the whole subject. A stroke's end may land in empty
// space and a relation's may not (ADR-0038 decision 2), so the same drag
// over the same pixels ends two different ways depending on which
// collection the element came from.

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { createIdleState, reduceGesture } from './gestures.js'

const canvas: SpatialCanvas = {
  nodes: [
    textNode({ id: 'a', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
    textNode({ id: 'b', x: 200, y: 0, width: 100, height: 50, text: 'b' }),
    textNode({ id: 'c', x: 400, y: 0, width: 100, height: 50, text: 'c' }),
  ],
  edges: [{ id: 'e1', from: { node: 'a' }, to: { node: 'b' } }],
  lines: [
    {
      id: 'l1',
      from: { kind: 'node', node: 'a' },
      to: { kind: 'point', point: { x: 300, y: 300 } },
    },
  ],
}

const arm = (elementId: string, endpoint: 'from' | 'to') =>
  reduceGesture(createIdleState(), canvas, { type: 'pointerdown-end', elementId, endpoint })

const release = (
  elementId: string,
  endpoint: 'from' | 'to',
  at: { x: number; y: number },
  targetNodeId?: string,
) =>
  reduceGesture(arm(elementId, endpoint).state, canvas, {
    type: 'pointerup',
    point: at,
    ...(targetNodeId === undefined ? {} : { targetNodeId }),
  })

/** What the reducer answers when a gesture ends having written nothing. */
const IDLE = { state: { kind: 'idle' }, commands: [] }

describe('arming an end drag', () => {
  it('remembers which end of which element is being dragged', () => {
    expect(arm('e1', 'to').state).toEqual({
      kind: 'reattaching',
      elementId: 'e1',
      endpoint: 'to',
    })
    expect(arm('l1', 'from').state).toEqual({
      kind: 'reattaching',
      elementId: 'l1',
      endpoint: 'from',
    })
  })

  it('arms nothing for an id the canvas does not hold', () => {
    expect(arm('gone', 'to').state.kind).toBe('idle')
  })

  it('abandons the drag when the element leaves mid-gesture', () => {
    const armed = arm('e1', 'to').state
    const without: SpatialCanvas = { ...canvas, edges: [] }
    const replaced = reduceGesture(armed, without, {
      type: 'canvas-replaced',
      canvas: without,
      origin: 'local',
    })
    expect(replaced.state.kind).toBe('idle')
  })
})

describe('releasing an end drag', () => {
  it('moves a relation onto the box under the release', () => {
    expect(release('e1', 'to', { x: 450, y: 25 }, 'c')).toMatchObject({
      state: { kind: 'idle' },
      commands: [{ kind: 'set-edge-end', id: 'e1', endpoint: 'to', node: 'c' }],
    })
  })

  it('leaves a relation where it was when the release lands in empty space', () => {
    // A relation cannot end nowhere, so there is no write to make and the
    // end snaps back — the user decision behind `endInkCommand` answering
    // undefined rather than turning the edge into a stroke.
    expect(release('e1', 'to', { x: 700, y: 700 })).toEqual(IDLE)
  })

  it('frees a stroke end into empty space, on whole units', () => {
    // Rounded for the reason a dragged bend is: a point somebody dragged to
    // is a point they can find again, and 137.4183 is not.
    expect(release('l1', 'from', { x: 640.6, y: 480.2 })).toMatchObject({
      commands: [
        {
          kind: 'set-line-end',
          id: 'l1',
          endpoint: 'from',
          target: { kind: 'point', point: { x: 641, y: 480 } },
        },
      ],
    })
  })

  it('attaches a free stroke end to the box under the release', () => {
    expect(release('l1', 'to', { x: 450, y: 25 }, 'c')).toMatchObject({
      commands: [
        { kind: 'set-line-end', id: 'l1', endpoint: 'to', target: { kind: 'node', node: 'c' } },
      ],
    })
  })

  it('writes nothing when the release names the box the end is already on', () => {
    // `onChange` runs for every command a result carries, so a write that
    // changes nothing would still land in history as an edit somebody can
    // undo and see no difference from. The same guard the move arms make
    // with `dx === 0 && dy === 0`.
    expect(release('e1', 'to', { x: 250, y: 25 }, 'b')).toEqual(IDLE)
    expect(release('l1', 'from', { x: 50, y: 25 }, 'a')).toEqual(IDLE)
  })

  it('writes nothing when the release names the box the OTHER end is on', () => {
    // Refusing a self-loop is the WRITE's rule and stays there; what is
    // here is only that a release which cannot change anything issues no
    // command, so the refusal never reaches history as an empty edit.
    expect(release('e1', 'to', { x: 50, y: 25 }, 'a')).toEqual(IDLE)
    expect(release('l1', 'to', { x: 50, y: 25 }, 'a')).toEqual(IDLE)
  })
})
