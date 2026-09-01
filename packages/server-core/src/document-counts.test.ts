import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { countAliveNodes, countLegacyTombstones } from './document-counts.js'

// Built through the real `writeSpatialCanvas` bridge rather than by poking at
// LoroDoc internals, so the fixture cannot drift from what a save actually
// persists. mcp-server's `test-utils/spatial-doc.ts` says the same and is
// shared by nine of its own tests; this needs only the one line of it, and
// hauling that file across a package boundary to avoid two lines would be
// the larger change.
function makeSpatialDoc(canvas: SpatialCanvas): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc
}

function legacyElement(doc: LoroDoc, id: string, isDeleted = false): void {
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(list.length, new LoroMap())
  map.set('id', id)
  map.set('type', 'rectangle')
  map.set('isDeleted', isDeleted)
  doc.commit()
}

describe('countAliveNodes', () => {
  it('counts nodes-model nodes and excludes edges', () => {
    const doc = makeSpatialDoc({
      nodes: [
        { id: 'n1', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'n2', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    })
    expect(countAliveNodes(doc)).toBe(2)
  })

  it('returns 0 for a fully empty doc', () => {
    const doc = makeSpatialDoc({ nodes: [], edges: [] })
    expect(countAliveNodes(doc)).toBe(0)
  })

  it('falls back to the legacy alive count when the nodes map is empty', () => {
    const doc = new LoroDoc()
    legacyElement(doc, 'el-1', false)
    legacyElement(doc, 'el-2', false)
    legacyElement(doc, 'el-3', true)
    expect(countAliveNodes(doc)).toBe(2)
  })

  it('counts only the nodes map, not stale legacy entries, once nodes are present', () => {
    const doc = makeSpatialDoc({
      nodes: [{ id: 'n1', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    legacyElement(doc, 'stale-1', false)
    legacyElement(doc, 'stale-2', false)
    expect(countAliveNodes(doc)).toBe(1)
  })

  it('drops a raw (non-map) legacy list entry instead of miscounting it as alive', () => {
    // A LoroMovableList can hold plain values alongside LoroMap containers.
    // A blind `as Array<{ isDeleted?: boolean }>` cast would read
    // `(42).isDeleted` as `undefined` and count this entry alive; the
    // schema-validated walk rejects it outright, same as the old
    // `instanceof LoroMap` guard did.
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    list.insert(0, 42)
    doc.commit()
    expect(countAliveNodes(doc)).toBe(0)
  })
})

describe('countLegacyTombstones', () => {
  it('counts tombstoned entries in a legacy-only doc', () => {
    const doc = new LoroDoc()
    legacyElement(doc, 'el-1', false)
    legacyElement(doc, 'el-2', true)
    legacyElement(doc, 'el-3', true)
    expect(countLegacyTombstones(doc)).toBe(2)
  })

  it('returns 0 once nodes are present, ignoring stale legacy tombstones', () => {
    const doc = makeSpatialDoc({
      nodes: [{ id: 'n1', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    legacyElement(doc, 'stale-dead', true)
    expect(countLegacyTombstones(doc)).toBe(0)
  })

  it('skips entries with a non-boolean isDeleted field instead of casting it', () => {
    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const map = list.insertContainer(list.length, new LoroMap())
    map.set('id', 'weird')
    map.set('isDeleted', 'true') // string, not boolean — must not count as a tombstone
    doc.commit()
    expect(countLegacyTombstones(doc)).toBe(0)
  })
})
