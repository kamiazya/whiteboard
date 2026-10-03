import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { readCoreFacets, readFacets, writeCoreFacets, writeFacets } from './document-envelope.js'
import { reconcileCoreFacets, reconcileFacets } from './document-envelope-reconcile.js'
import {
  readSpatialCanvas,
  readSpatialCanvasWithSkipped,
  reconcileSpatialCanvas,
  writeSpatialCanvas,
} from './loro-bridge.js'

const NEON = { 'visual.theme/v0': { theme: 'visual.neon' } }
const FUTURE = { from: 'the future' }

function canvasWithBadFacetKey(): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [], edges: [] })
  doc.getMap('canvas').set('facets', { ...NEON, 'Bad Key': FUTURE })
  doc.commit()
  return doc
}

describe('reconcileFacets', () => {
  test('deletes a key the edit visibly dropped and leaves one the reader never showed', () => {
    const doc = new LoroDoc()
    writeFacets(doc, { 'example.kanban/v1': { status: 'todo' }, 'example.note/v1': { n: 1 } })
    doc.getMap('facets').set('Bad Key', FUTURE)
    doc.commit()
    const prev = readFacets(doc)

    reconcileFacets(doc, prev, { 'example.kanban/v1': { status: 'done' } })

    expect(doc.getMap('facets').toJSON()).toEqual({
      'example.kanban/v1': { status: 'done' },
      'Bad Key': FUTURE,
    })
  })

  test('writes nothing when the edit changed nothing', () => {
    const doc = new LoroDoc()
    writeFacets(doc, { 'example.kanban/v1': { status: 'todo' } })
    const before = doc.oplogVersion()

    reconcileFacets(doc, readFacets(doc), readFacets(doc))

    expect(doc.oplogVersion().compare(before)).toBe(0)
  })
})

describe('reconcileCoreFacets', () => {
  test('keeps a core field the schema does not know, and drops one the edit removed', () => {
    const doc = new LoroDoc()
    writeCoreFacets(doc, { type: 'note', view: 'board', tags: ['a'] })
    doc.getMap('core').set('futureCoreField', FUTURE)
    doc.commit()

    reconcileCoreFacets(doc, readCoreFacets(doc), { type: 'note', tags: ['a', 'b'] })

    expect(doc.getMap('core').toJSON()).toEqual({
      type: 'note',
      tags: ['a', 'b'],
      futureCoreField: FUTURE,
    })
  })

  test('creates the bucket when none was readable', () => {
    const doc = new LoroDoc()

    reconcileCoreFacets(doc, undefined, { type: 'note' })

    expect(readCoreFacets(doc)).toEqual({ type: 'note' })
  })
})

describe('a canvas facets bucket holding a key outside the grammar', () => {
  test('reads the valid facets beside it and counts the entry it skipped', () => {
    const doc = canvasWithBadFacetKey()

    expect(readSpatialCanvas(doc).facets).toEqual(NEON)
    expect(readSpatialCanvasWithSkipped(doc).skipped).toBe(1)
  })

  test('reads as no facets when none of its keys is readable', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [], edges: [] })
    doc.getMap('canvas').set('facets', { 'Bad Key': FUTURE })
    doc.commit()

    expect(readSpatialCanvas(doc).facets).toBeUndefined()
  })

  test('a reconcile adding a facet keeps the unreadable entry', () => {
    const doc = canvasWithBadFacetKey()
    const prev = readSpatialCanvas(doc)

    reconcileSpatialCanvas(doc, prev, {
      ...prev,
      facets: { ...prev.facets, 'visual.edges/v0': { routing: 'orthogonal' } },
    })

    expect(doc.getMap('canvas').get('facets')).toEqual({
      ...NEON,
      'visual.edges/v0': { routing: 'orthogonal' },
      'Bad Key': FUTURE,
    })
  })

  test('a reconcile clearing every visible facet leaves only the unreadable entry', () => {
    const doc = canvasWithBadFacetKey()
    const { facets: _cleared, ...prev } = { ...readSpatialCanvas(doc) }

    reconcileSpatialCanvas(doc, readSpatialCanvas(doc), prev)

    expect(doc.getMap('canvas').get('facets')).toEqual({ 'Bad Key': FUTURE })
  })

  test('a reconcile clearing a bucket with nothing unreadable removes the field', () => {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [], edges: [], facets: NEON })
    const prev = readSpatialCanvas(doc)

    reconcileSpatialCanvas(doc, prev, { nodes: [], edges: [] })

    expect(doc.getMap('canvas').get('facets')).toBeUndefined()
  })
})
