import { toJsonCanvas } from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { LoadedReference } from './loaded-reference.js'
import {
  loadedReferenceFromWire,
  loadedReferenceToWire,
  loadedReferenceWireSchema,
} from './wire-schema.js'

const BOARD: SpatialCanvas = {
  nodes: [textNode({ id: 'n', x: 0, y: 0, width: 100, height: 40, text: 'inside' })],
  edges: [],
}

describe('loadedReferenceWireSchema', () => {
  it('round-trips a loaded canvas through what the producer writes and the schema admits', () => {
    const loaded: LoadedReference = {
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      name: 'B',
      canvas: BOARD,
    }
    const wire = loadedReferenceToWire(loaded)
    // The wire IS the projection, which is what a reader of the wire parses.
    expect(wire.canvas).toEqual(toJsonCanvas(BOARD))
    const parsed = loadedReferenceWireSchema.parse(JSON.parse(JSON.stringify(wire)))
    expect(loadedReferenceFromWire(parsed)).toEqual(loaded)
  })

  it('omits what was not loaded rather than sending undefined', () => {
    expect(loadedReferenceToWire({ body: 'a note' })).toEqual({ body: 'a note' })
    expect(loadedReferenceFromWire({ name: 'only a name' })).toEqual({ name: 'only a name' })
  })

  it('refuses the model shape on the wire, so a producer cannot skip the projection', () => {
    expect(loadedReferenceWireSchema.safeParse({ canvas: BOARD }).success).toBe(false)
  })
})
