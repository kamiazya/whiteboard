// @vitest-environment node

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { type ListedDocument, loadedReferenceOf } from './loaded-reference-of.js'

const BOARD_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'n', x: 0, y: 0, width: 10, height: 10, text: 'x' })],
  edges: [],
}
const LEGACY_ID = 'legacy-row-id'
const PRE_KIND_ID = 'pre-kind-row-id'
const NOTE_ID = 'note-row-id'
const entries: ListedDocument[] = [
  { documentId: BOARD_ID, path: 'boards/roadmap', kind: 'spatial' },
  { documentId: LEGACY_ID, path: 'boards/legacy', kind: 'spatial' },
  { documentId: PRE_KIND_ID, path: 'boards/pre-kind' },
  { documentId: NOTE_ID, path: 'notes/plan', kind: 'markdown' },
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

  it('reads a listed row that names no kind as a canvas, the kind every pre-kind document was', () => {
    expect(
      loadedReferenceOf({ canvas, body: 'stored form' }, entries, 'boards/pre-kind', PRE_KIND_ID),
    ).toEqual({ documentId: PRE_KIND_ID, canvas })
  })

  it('answers the body of a listed markdown row even when the stored form also parses as a canvas', () => {
    expect(loadedReferenceOf({ canvas, body: '# plan' }, entries, 'notes/plan', NOTE_ID)).toEqual({
      documentId: NOTE_ID,
      body: '# plan',
    })
  })
})
