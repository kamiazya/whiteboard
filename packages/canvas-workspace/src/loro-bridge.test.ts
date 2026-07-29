import type {
  CanvasEdge,
  ExtensionFacets,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-canvas-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { readFacets, readSpatialCanvas, writeFacets, writeSpatialCanvas } from './loro-bridge.js'

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
