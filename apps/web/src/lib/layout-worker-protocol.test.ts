// @vitest-environment node
/**
 * The wire's whole claim is that everything on it is structured-cloneable
 * and that the seams rebuilt from it answer as the seams it was made from.
 * A field that is a function would throw in `structuredClone` — which is
 * exactly the failure a real `postMessage` would raise, and the one this
 * file exists to catch before a worker does.
 */
import { referenceSeamsFromWire, referenceWire } from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { LayoutRequest } from './layout-worker-protocol.js'

const NOTE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const canvas: SpatialCanvas = {
  nodes: [
    { id: 'a', type: 'text', x: 0, y: 0, width: 100, height: 60, text: `see ![[${NOTE_ID}]]` },
    { id: 'f', type: 'file', x: 200, y: 0, width: 100, height: 60, file: 'doc-1' },
  ],
  edges: [],
}

describe('LayoutRequest', () => {
  it('carries the reference bundle as data that survives structuredClone and rebuilds the same seams', () => {
    const wire = referenceWire(
      new Map([
        [NOTE_ID, { documentId: NOTE_ID, name: 'Note', body: '# From the note' }],
        ['doc-1', { canvas: { nodes: [], edges: [] } }],
      ]),
      {
        resolveTitle: (id) => (id === NOTE_ID ? 'Note' : undefined),
        extras: new Map([['doc-1', { label: 'Doc one' }]]),
      },
    )
    const request: LayoutRequest = {
      type: 'layout',
      id: 1,
      canvas,
      theme: 'light',
      references: wire,
      expandedFileIds: ['f'],
      fileRefLabels: [{ file: 'doc-1', label: 'Doc one' }],
      missingFileRefs: [],
    }
    const crossed = structuredClone(request)
    expect(crossed).toEqual(request)

    const seams = referenceSeamsFromWire(crossed.references as typeof wire)
    expect(seams.resolveEmbed(NOTE_ID)?.title).toBe('Note')
    expect(seams.resolveTitle(NOTE_ID)).toBe('Note')
    // An empty canvas is a card for a file node, with the surface's label.
    expect(seams.resolveReference('doc-1')).toEqual({ label: 'Doc one' })
  })
})
