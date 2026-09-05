import { referenceWire } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useCanvasReferences } from './use-canvas-references.js'

const canvas: SpatialCanvas = {
  nodes: [
    { id: 't', type: 'text', x: 0, y: 0, width: 200, height: 100, text: 'see [[notes/plan]]' },
  ],
  edges: [],
}
const NOTE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('useCanvasReferences', () => {
  it('hands back the same wire while what the canvas can read is unchanged, and a new one when it changes', () => {
    // The keeper's wire grows for a body drafted beside the canvas; the
    // canvas's layout, its worker request and its content cache all key on
    // the identity handed back here, so growth it cannot read must not move it.
    const base = referenceWire(
      new Map([['notes/plan', { documentId: NOTE_ID, body: 'the plan' }]]),
      {
        resolveTitle: (id) => (id === NOTE_ID ? 'Plan' : undefined),
      },
    )
    const { result, rerender } = renderHook(
      ({ references }) => useCanvasReferences(canvas, references),
      {
        initialProps: { references: base },
      },
    )
    const first = result.current
    expect(first.wire?.entries.map(([key]) => key)).toEqual(['notes/plan'])

    const grown = referenceWire(
      new Map([
        ['notes/plan', { documentId: NOTE_ID, body: 'the plan' }],
        ['notes/drafted', { body: 'typed beside the canvas' }],
      ]),
      { resolveTitle: (id) => (id === NOTE_ID ? 'Plan' : undefined) },
    )
    rerender({ references: grown })
    expect(result.current).toBe(first)

    const edited = referenceWire(
      new Map([['notes/plan', { documentId: NOTE_ID, body: 'the plan, revised' }]]),
      {
        resolveTitle: (id) => (id === NOTE_ID ? 'Plan' : undefined),
      },
    )
    rerender({ references: edited })
    expect(result.current).not.toBe(first)
    expect(result.current.wire?.entries[0]?.[1]?.body).toBe('the plan, revised')
  })

  it('is absent when the host resolves nothing', () => {
    const { result } = renderHook(() => useCanvasReferences(canvas, undefined))
    expect(result.current.wire).toBeUndefined()
    expect(result.current.seams).toBeUndefined()
  })
})
