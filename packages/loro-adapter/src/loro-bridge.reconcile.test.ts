import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, UndoManager } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  readSpatialCanvas,
  reconcileSpatialCanvas,
  withSpatialBatch,
  writeSpatialCanvas,
} from './loro-bridge.js'

const A = textNode({ id: 'a', text: 'alpha', x: 0, y: 0, width: 10, height: 10 })

function seeded(extra: Partial<SpatialCanvas> = {}): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, { nodes: [A], edges: [], ...extra })
  return doc
}

// The canvas-level `facets` and `tags` are single values on the canvas map,
// outside the id-keyed node/edge/comment passes, so a reconcile that only
// moved one of them has to reach them through its own write.
describe('reconcileSpatialCanvas canvas-level fields', () => {
  test('a tag-only change is written and leaves the facets beside it alone', () => {
    const doc = seeded({ tags: ['draft'], facets: { 'visual.canvas/v0': { grid: true } } })
    const prev = readSpatialCanvas(doc)

    reconcileSpatialCanvas(doc, prev, { ...prev, tags: ['draft', 'review'] })

    const after = readSpatialCanvas(doc)
    expect(after.tags).toEqual(['draft', 'review'])
    expect(after.facets).toEqual({ 'visual.canvas/v0': { grid: true } })
  })

  test('a facet-only change is written and leaves the tags beside it alone', () => {
    const doc = seeded({ tags: ['draft'], facets: { 'visual.canvas/v0': { grid: true } } })
    const prev = readSpatialCanvas(doc)

    reconcileSpatialCanvas(doc, prev, { ...prev, facets: { 'visual.canvas/v0': { grid: false } } })

    const after = readSpatialCanvas(doc)
    expect(after.facets).toEqual({ 'visual.canvas/v0': { grid: false } })
    expect(after.tags).toEqual(['draft'])
  })

  test('dropping the tags and the facets removes them rather than storing an empty value', () => {
    const doc = seeded({ tags: ['draft'], facets: { 'visual.canvas/v0': { grid: true } } })
    const prev = readSpatialCanvas(doc)

    reconcileSpatialCanvas(doc, prev, { nodes: prev.nodes, edges: prev.edges })

    const after = readSpatialCanvas(doc)
    expect(after.tags).toBeUndefined()
    expect(after.facets).toBeUndefined()
    // The reader parses a stored null back to undefined, so the stored keys
    // are what tell a removal from a null left behind.
    expect([...doc.getMap('canvas').keys()]).not.toContain('tags')
    expect([...doc.getMap('canvas').keys()]).not.toContain('facets')
  })

  test('a canvas-level change commits as one step the undo history can take back', () => {
    const doc = seeded({ tags: ['draft'] })
    const prev = readSpatialCanvas(doc)
    const undo = new UndoManager(doc, { mergeInterval: 0 })

    reconcileSpatialCanvas(doc, prev, { ...prev, tags: ['review'] })
    expect(undo.canUndo()).toBe(true)
    undo.undo()

    expect(readSpatialCanvas(doc).tags).toEqual(['draft'])
  })

  test('unchanged tags and facets write no op', () => {
    const doc = seeded({ tags: ['draft'], facets: { 'visual.canvas/v0': { grid: true } } })
    const prev = readSpatialCanvas(doc)
    const before = doc.oplogVersion()

    reconcileSpatialCanvas(doc, prev, { ...prev, tags: [...(prev.tags ?? [])] })

    expect(doc.oplogVersion().compare(before)).toBe(0)
  })
})

describe('reconcileSpatialCanvas commit arm', () => {
  test('an unchanged canvas leaves a pending op of its caller uncommitted', () => {
    const doc = seeded({ tags: ['draft'] })
    const prev = readSpatialCanvas(doc)
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    doc.getMap('scratch').set('pending', 1)

    reconcileSpatialCanvas(doc, prev, prev)

    expect(undo.canUndo()).toBe(false)
  })
})

describe('withSpatialBatch commit arm', () => {
  // A batch that wrote nothing must not commit: whatever is already pending
  // on the doc belongs to its own caller's boundary, and committing it here
  // would fold that work into a step nobody asked for.
  test('a batch that writes nothing leaves a pending op of its caller uncommitted', () => {
    const doc = seeded()
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    doc.getMap('scratch').set('pending', 1)

    withSpatialBatch(doc, (w) => w.deleteNode('ghost'))

    expect(undo.canUndo()).toBe(false)
  })

  test('a batch that writes commits the pending op together with its own writes', () => {
    const doc = seeded()
    const undo = new UndoManager(doc, { mergeInterval: 0 })
    doc.getMap('scratch').set('pending', 1)

    withSpatialBatch(doc, (w) => w.deleteNode(A.id))

    expect(undo.canUndo()).toBe(true)
  })
})
