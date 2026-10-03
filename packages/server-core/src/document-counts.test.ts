import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { countAliveNodes } from './document-counts.js'

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

function legacyElement(doc: LoroDoc, id: string): void {
  const list = doc.getMovableList('elements')
  const map = list.insertContainer(list.length, new LoroMap())
  map.set('id', id)
  map.set('type', 'rectangle')
  doc.commit()
}

describe('countAliveNodes', () => {
  it('counts nodes-model nodes and excludes edges', () => {
    const doc = makeSpatialDoc({
      nodes: [
        textNode({ id: 'n1', text: 'a', x: 0, y: 0, width: 10, height: 10 }),
        textNode({ id: 'n2', text: 'b', x: 0, y: 0, width: 10, height: 10 }),
      ],
      edges: [
        {
          id: 'e1',
          from: { node: 'n1' },
          to: { node: 'n2' },
        },
      ],
    })
    expect(countAliveNodes(doc)).toBe(2)
  })

  it('returns 0 for a fully empty doc', () => {
    const doc = makeSpatialDoc({ nodes: [], edges: [] })
    expect(countAliveNodes(doc)).toBe(0)
  })

  it('counts nothing for a doc that holds only the retired elements list', () => {
    const doc = new LoroDoc()
    legacyElement(doc, 'el-1')
    legacyElement(doc, 'el-2')
    expect(countAliveNodes(doc)).toBe(0)
  })

  it('leaves no elements container behind on a doc that never had one', () => {
    const doc = makeSpatialDoc({ nodes: [], edges: [] })
    countAliveNodes(doc)
    expect(Object.keys(doc.getShallowValue())).not.toContain('elements')
  })

  it('counts only the nodes map, not stale legacy entries, once nodes are present', () => {
    const doc = makeSpatialDoc({
      nodes: [textNode({ id: 'n1', text: 'a', x: 0, y: 0, width: 10, height: 10 })],
      edges: [],
    })
    legacyElement(doc, 'stale-1')
    legacyElement(doc, 'stale-2')
    expect(countAliveNodes(doc)).toBe(1)
  })
})
