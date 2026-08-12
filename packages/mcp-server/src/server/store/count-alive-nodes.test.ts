import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { makeSpatialDoc } from '../../shared/test-utils/spatial-doc.js'
import { countAliveNodes } from './count-alive-nodes.js'

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
})
