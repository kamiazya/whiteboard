import type {
  CanvasCoreMeta,
  CanvasEdge,
  ExtensionFacets,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-canvas-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  deleteSpatialEdge,
  deleteSpatialNode,
  readCoreFacets,
  readFacets,
  readSpatialCanvas,
  writeCoreFacets,
  writeFacets,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
} from './loro-bridge.js'

function makeDoc(): LoroDoc {
  return new LoroDoc()
}

const TEXT_NODE: SpatialNode = {
  id: 'node-1',
  type: 'text',
  x: 100,
  y: 200,
  width: 300,
  height: 150,
  text: 'Hello world',
}

const FILE_NODE: SpatialNode = {
  id: 'node-2',
  type: 'file',
  x: 500,
  y: 200,
  width: 200,
  height: 200,
  file: 'image.png',
  subpath: '#page1',
}

const LINK_NODE: SpatialNode = {
  id: 'node-3',
  type: 'link',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  url: 'https://example.com',
}

const GROUP_NODE: SpatialNode = {
  id: 'node-4',
  type: 'group',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  label: 'My Group',
  background: '#ff0000',
  backgroundStyle: 'cover',
}

const EDGE: CanvasEdge = {
  id: 'edge-1',
  fromNode: 'node-1',
  toNode: 'node-2',
  fromSide: 'right',
  toSide: 'left',
  toEnd: 'arrow',
  label: 'connects',
}

describe('loro-bridge', () => {
  test('round-trips a text node', () => {
    const doc = makeDoc()
    const canvas: SpatialCanvas = { nodes: [TEXT_NODE], edges: [] }

    writeSpatialCanvas(doc, canvas)
    const result = readSpatialCanvas(doc)

    expect(result.nodes).toEqual([TEXT_NODE])
    expect(result.edges).toEqual([])
  })

  test('round-trips a file node with subpath', () => {
    const doc = makeDoc()
    const canvas: SpatialCanvas = { nodes: [FILE_NODE], edges: [] }

    writeSpatialCanvas(doc, canvas)
    const result = readSpatialCanvas(doc)

    expect(result.nodes).toEqual([FILE_NODE])
  })

  test('round-trips a link node', () => {
    const doc = makeDoc()
    const canvas: SpatialCanvas = { nodes: [LINK_NODE], edges: [] }

    writeSpatialCanvas(doc, canvas)
    const result = readSpatialCanvas(doc)

    expect(result.nodes).toEqual([LINK_NODE])
  })

  test('round-trips a group node with all optional fields', () => {
    const doc = makeDoc()
    const canvas: SpatialCanvas = { nodes: [GROUP_NODE], edges: [] }

    writeSpatialCanvas(doc, canvas)
    const result = readSpatialCanvas(doc)

    expect(result.nodes).toEqual([GROUP_NODE])
  })

  test('round-trips edges', () => {
    const doc = makeDoc()
    const canvas: SpatialCanvas = { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] }

    writeSpatialCanvas(doc, canvas)
    const result = readSpatialCanvas(doc)

    expect(result.edges).toEqual([EDGE])
  })

  test('round-trips node with color', () => {
    const doc = makeDoc()
    const node: SpatialNode = { ...TEXT_NODE, color: '3' }
    const canvas: SpatialCanvas = { nodes: [node], edges: [] }

    writeSpatialCanvas(doc, canvas)
    const result = readSpatialCanvas(doc)

    expect(result.nodes[0].color).toBe('3')
  })

  test('round-trips node with x-whiteboard shape extension', () => {
    const doc = makeDoc()
    const node: SpatialNode = {
      ...TEXT_NODE,
      'x-whiteboard': { kind: 'shape', shape: 'ellipse' },
    }
    const canvas: SpatialCanvas = { nodes: [node], edges: [] }

    writeSpatialCanvas(doc, canvas)
    const result = readSpatialCanvas(doc)

    expect(result.nodes[0]['x-whiteboard']).toEqual({ kind: 'shape', shape: 'ellipse' })
  })

  test('round-trips node with x-whiteboard freehand extension', () => {
    const doc = makeDoc()
    const node: SpatialNode = {
      id: 'freehand-1',
      type: 'text',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      text: '',
      'x-whiteboard': {
        kind: 'freehand',
        points: [
          [0, 0],
          [10, 20],
          [30, 40],
        ],
        pressures: [0.5, 0.8, 1.0],
        strokeWidth: 2,
      },
    }
    const canvas: SpatialCanvas = { nodes: [node], edges: [] }

    writeSpatialCanvas(doc, canvas)
    const result = readSpatialCanvas(doc)

    expect(result.nodes[0]['x-whiteboard']).toEqual(node['x-whiteboard'])
  })

  test('overwrites existing canvas data', () => {
    const doc = makeDoc()

    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })
    writeSpatialCanvas(doc, { nodes: [LINK_NODE], edges: [] })

    const result = readSpatialCanvas(doc)
    expect(result.nodes).toEqual([LINK_NODE])
    expect(result.edges).toEqual([])
  })

  test('removes deleted nodes and edges on overwrite', () => {
    const doc = makeDoc()

    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE], edges: [] })

    const result = readSpatialCanvas(doc)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].id).toBe('node-1')
    expect(result.edges).toHaveLength(0)
  })

  test('reads empty canvas from fresh doc', () => {
    const doc = makeDoc()
    const result = readSpatialCanvas(doc)

    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
  })

  test('CRDT merge: two docs add different nodes', () => {
    const doc1 = new LoroDoc()
    const doc2 = new LoroDoc()

    writeSpatialCanvas(doc1, { nodes: [TEXT_NODE], edges: [] })
    writeSpatialCanvas(doc2, { nodes: [LINK_NODE], edges: [] })

    doc1.import(doc2.export({ mode: 'snapshot' }))

    const result = readSpatialCanvas(doc1)
    expect(result.nodes).toHaveLength(2)
    const ids = result.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['node-1', 'node-3'])
  })

  test('updates existing node fields in place', () => {
    const doc = makeDoc()

    writeSpatialCanvas(doc, { nodes: [TEXT_NODE], edges: [] })

    const updated: SpatialNode = { ...TEXT_NODE, text: 'Updated text', x: 999 }
    writeSpatialCanvas(doc, { nodes: [updated], edges: [] })

    const result = readSpatialCanvas(doc)
    expect(result.nodes).toHaveLength(1)
    const node0 = result.nodes[0]
    expect(node0.type).toBe('text')
    if (node0.type === 'text') {
      expect(node0.text).toBe('Updated text')
    }
    expect(node0.x).toBe(999)
  })

  test('round-trips edge with minimal fields', () => {
    const doc = makeDoc()
    const minimalEdge: CanvasEdge = {
      id: 'edge-min',
      fromNode: 'node-1',
      toNode: 'node-2',
    }
    const canvas: SpatialCanvas = { nodes: [TEXT_NODE, FILE_NODE], edges: [minimalEdge] }

    writeSpatialCanvas(doc, canvas)
    const result = readSpatialCanvas(doc)

    expect(result.edges).toEqual([minimalEdge])
  })

  test('writeSpatialNode writes exactly one node without touching others', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [] })

    const updated: SpatialNode = { ...TEXT_NODE, text: 'fine-grained update' }
    writeSpatialNode(doc, updated)

    const result = readSpatialCanvas(doc)
    expect(result.nodes).toHaveLength(2)
    const node0 = result.nodes.find((n) => n.id === TEXT_NODE.id)
    expect(node0?.type).toBe('text')
    if (node0?.type === 'text') expect(node0.text).toBe('fine-grained update')
    expect(result.nodes.find((n) => n.id === FILE_NODE.id)).toEqual(FILE_NODE)
  })

  test('writeSpatialEdge writes exactly one edge without touching others', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })

    const otherEdge: CanvasEdge = { id: 'edge-2', fromNode: 'node-2', toNode: 'node-1' }
    writeSpatialEdge(doc, otherEdge)

    const result = readSpatialCanvas(doc)
    expect(result.edges).toHaveLength(2)
    expect(result.edges.find((e) => e.id === EDGE.id)).toEqual(EDGE)
    expect(result.edges.find((e) => e.id === otherEdge.id)).toEqual(otherEdge)
  })

  test('writeSpatialNode preserves an unrelated node added by a concurrent CRDT merge', () => {
    const doc1 = new LoroDoc()
    const doc2 = new LoroDoc()
    writeSpatialCanvas(doc1, { nodes: [TEXT_NODE], edges: [] })
    doc2.import(doc1.export({ mode: 'snapshot' }))

    writeSpatialNode(doc2, LINK_NODE)
    doc1.import(doc2.export({ mode: 'snapshot' }))

    const result = readSpatialCanvas(doc1)
    const ids = result.nodes.map((n) => n.id).sort()
    expect(ids).toEqual([TEXT_NODE.id, LINK_NODE.id].sort())
  })

  test('deleteSpatialNode removes the node and cascades to its incident edges', () => {
    const doc = makeDoc()
    const otherEdge: CanvasEdge = { id: 'edge-2', fromNode: 'node-2', toNode: 'node-1' }
    writeSpatialCanvas(doc, {
      nodes: [TEXT_NODE, FILE_NODE, LINK_NODE],
      edges: [EDGE, otherEdge],
    })

    deleteSpatialNode(doc, TEXT_NODE.id)

    const result = readSpatialCanvas(doc)
    expect(result.nodes.map((n) => n.id).sort()).toEqual([FILE_NODE.id, LINK_NODE.id].sort())
    expect(result.edges).toEqual([])
  })

  test('deleteSpatialNode keeps the other nodes and cascades only the incident edge', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })

    deleteSpatialNode(doc, FILE_NODE.id)

    const result = readSpatialCanvas(doc)
    expect(result.nodes).toEqual([TEXT_NODE])
    // EDGE references node-1/node-2; node-2 (FILE_NODE) was removed so its
    // incident edge must cascade too.
    expect(result.edges).toEqual([])
  })

  test('deleteSpatialNode leaves an edge between two surviving nodes alone', () => {
    // Every other edge in this suite joins node-1 and node-2, so every other
    // deletion removes one of its endpoints. Without a third node, an
    // implementation that simply cleared the whole edges map would satisfy
    // the entire cascade suite — this is the case that separates "cascade
    // the incident edges" from "drop them all".
    const doc = makeDoc()
    const thirdNode = { ...TEXT_NODE, id: 'node-3', x: 500 }
    const survivingEdge: CanvasEdge = { id: 'edge-keep', fromNode: 'node-1', toNode: 'node-3' }
    writeSpatialCanvas(doc, {
      nodes: [TEXT_NODE, FILE_NODE, thirdNode],
      edges: [EDGE, survivingEdge],
    })

    deleteSpatialNode(doc, FILE_NODE.id)

    const result = readSpatialCanvas(doc)
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['node-1', 'node-3'])
    expect(result.edges).toEqual([survivingEdge])
  })

  test('deleteSpatialNode is idempotent and a no-op for a missing id', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE], edges: [] })

    deleteSpatialNode(doc, 'missing-id')
    deleteSpatialNode(doc, TEXT_NODE.id)
    deleteSpatialNode(doc, TEXT_NODE.id)

    const result = readSpatialCanvas(doc)
    expect(result.nodes).toEqual([])
  })

  test('deleteSpatialNode is a single commit: one UndoManager step restores node and edges together', async () => {
    const { UndoManager } = await import('loro-crdt')
    const doc = makeDoc()
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })
    const undoManager = new UndoManager(doc, {})

    deleteSpatialNode(doc, TEXT_NODE.id)
    undoManager.undo()

    const result = readSpatialCanvas(doc)
    expect(result.nodes.map((n) => n.id).sort()).toEqual([TEXT_NODE.id, FILE_NODE.id].sort())
    expect(result.edges).toEqual([EDGE])
  })

  test('deleteSpatialEdge removes exactly one edge, leaving nodes and other edges untouched', () => {
    const doc = makeDoc()
    const otherEdge: CanvasEdge = { id: 'edge-2', fromNode: 'node-2', toNode: 'node-1' }
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE, otherEdge] })

    deleteSpatialEdge(doc, EDGE.id)

    const result = readSpatialCanvas(doc)
    expect(result.nodes).toHaveLength(2)
    expect(result.edges).toEqual([otherEdge])
  })
})

describe('facets bridge', () => {
  test('reads empty facets from a fresh doc', () => {
    const doc = makeDoc()
    expect(readFacets(doc)).toEqual({})
  })

  test('round-trips a single facet domain', () => {
    const doc = makeDoc()
    const facets: ExtensionFacets = { 'kanban/1': { status: 'in-progress' } }

    writeFacets(doc, facets)

    expect(readFacets(doc)).toEqual(facets)
  })

  test('round-trips multiple facet domains', () => {
    const doc = makeDoc()
    const facets: ExtensionFacets = {
      'kanban/1': { status: 'in-progress' },
      'priority/1': { level: 'high' },
    }

    writeFacets(doc, facets)

    expect(readFacets(doc)).toEqual(facets)
  })

  test('merges new facet keys with existing ones on write', () => {
    const doc = makeDoc()

    writeFacets(doc, { 'kanban/1': { status: 'todo' } })
    writeFacets(doc, {
      'kanban/1': { status: 'done' },
      'priority/1': { level: 'low' },
    })

    expect(readFacets(doc)).toEqual({
      'kanban/1': { status: 'done' },
      'priority/1': { level: 'low' },
    })
  })

  test('deletes facet keys absent from a later write', () => {
    const doc = makeDoc()

    writeFacets(doc, {
      'kanban/1': { status: 'todo' },
      'priority/1': { level: 'low' },
    })
    writeFacets(doc, { 'kanban/1': { status: 'todo' } })

    expect(readFacets(doc)).toEqual({ 'kanban/1': { status: 'todo' } })
  })

  test('CRDT merge: two docs add different facet domains', () => {
    const doc1 = new LoroDoc()
    const doc2 = new LoroDoc()

    writeFacets(doc1, { 'kanban/1': { status: 'todo' } })
    writeFacets(doc2, { 'priority/1': { level: 'high' } })

    doc1.import(doc2.export({ mode: 'snapshot' }))

    expect(readFacets(doc1)).toEqual({
      'kanban/1': { status: 'todo' },
      'priority/1': { level: 'high' },
    })
  })

  test('ignores a malformed facet key found in the underlying map', () => {
    const doc = makeDoc()
    doc.getMap('facets').set('not-a-valid-key', { anything: true })
    doc.commit()

    expect(readFacets(doc)).toEqual({})
  })
})

describe('core facets bridge', () => {
  test('reads undefined core meta from a fresh doc', () => {
    const doc = makeDoc()
    expect(readCoreFacets(doc)).toBeUndefined()
  })

  test('round-trips every core field', () => {
    const doc = makeDoc()
    const meta: CanvasCoreMeta = {
      type: 'note',
      title: 'A note',
      tags: ['idea', 'browser'],
      view: 'kanban/1',
      facetsRaw: { customKey: 'value' },
    }

    writeCoreFacets(doc, meta)

    expect(readCoreFacets(doc)).toEqual(meta)
  })

  test('round-trips the minimal (type-only) core meta', () => {
    const doc = makeDoc()
    const meta: CanvasCoreMeta = { type: 'canvas' }

    writeCoreFacets(doc, meta)

    expect(readCoreFacets(doc)).toEqual(meta)
  })

  test('a later write replaces the whole document meta: an omitted optional field disappears', () => {
    const doc = makeDoc()

    writeCoreFacets(doc, { type: 'note', title: 'First title', tags: ['a'] })
    writeCoreFacets(doc, { type: 'note' })

    expect(readCoreFacets(doc)).toEqual({ type: 'note' })
  })

  test('writing core meta never touches the extension facets bucket', () => {
    const doc = makeDoc()
    writeFacets(doc, { 'kanban/1': { status: 'todo' } })

    writeCoreFacets(doc, { type: 'note', title: 'Untouched-adjacent' })

    expect(readFacets(doc)).toEqual({ 'kanban/1': { status: 'todo' } })
  })

  test('writing extension facets never touches the core meta bucket', () => {
    const doc = makeDoc()
    writeCoreFacets(doc, { type: 'note', title: 'Stable' })

    writeFacets(doc, { 'kanban/1': { status: 'todo' } })

    expect(readCoreFacets(doc)).toEqual({ type: 'note', title: 'Stable' })
  })

  test('CRDT merge: two docs independently write different core-meta fields converge on both', () => {
    const doc1 = new LoroDoc()
    const doc2 = new LoroDoc()

    writeCoreFacets(doc1, { type: 'note' })
    doc2.import(doc1.export({ mode: 'snapshot' }))
    writeCoreFacets(doc1, { type: 'note', title: 'From doc1' })
    writeCoreFacets(doc2, { type: 'note', tags: ['from-doc2'] })

    doc1.import(doc2.export({ mode: 'snapshot' }))

    const merged = readCoreFacets(doc1)
    expect(merged?.type).toBe('note')
    expect(merged?.title).toBe('From doc1')
    expect(merged?.tags).toEqual(['from-doc2'])
  })

  test('drops a single corrupt field but keeps the rest when type is still valid', () => {
    const doc = makeDoc()
    doc.getMap('core').set('type', 'note')
    doc.getMap('core').set('title', 'Kept title')
    doc.getMap('core').set('tags', 'not-an-array')
    doc.commit()

    expect(readCoreFacets(doc)).toEqual({ type: 'note', title: 'Kept title' })
  })

  test('returns undefined when the required type field is missing or invalid', () => {
    const doc = makeDoc()
    doc.getMap('core').set('title', 'Orphan title, no type')
    doc.commit()

    expect(readCoreFacets(doc)).toBeUndefined()
  })
})
