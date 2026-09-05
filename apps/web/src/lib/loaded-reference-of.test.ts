// @vitest-environment node
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { type ListedDocument, loadedReferenceOf } from './loaded-reference-of.js'

const BOARD_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const canvas: SpatialCanvas = {
  nodes: [{ id: 'n', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'x' }],
  edges: [],
}
const LEGACY_ID = 'legacy-row-id'
const entries: ListedDocument[] = [
  { id: BOARD_ID, path: 'boards/roadmap', kind: 'spatial' },
  { id: LEGACY_ID, path: 'boards/legacy', kind: 'spatial' },
]

describe('loadedReferenceOf', () => {
  it('answers a spatial entry with its canvas, found by id', () => {
    expect(
      loadedReferenceOf({ canvas, body: 'stored form' }, entries, 'boards/roadmap', BOARD_ID),
    ).toEqual({ documentId: BOARD_ID, canvas })
  })

  it('finds an id-less path reference by its path, so a legacy canvas reference still draws a canvas', () => {
    // No id known to the page's table: the entry is matched on the path the
    // reference was written as, its kind decides, and its id rides along.
    expect(
      loadedReferenceOf({ canvas, body: 'stored form' }, entries, 'boards/legacy', null),
    ).toEqual({ documentId: LEGACY_ID, canvas })
  })

  it('answers a body for a markdown or unlisted document, carrying the entry id when it has one', () => {
    expect(loadedReferenceOf({ body: '# note' }, entries, 'notes/x', null)).toEqual({
      body: '# note',
    })
  })
})
