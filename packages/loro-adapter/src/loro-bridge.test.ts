import type {
  CanvasComment,
  CanvasEdge,
  ExtensionFacets,
  SpatialCanvas,
  SpatialNode,
  StoredCoreFacets,
} from '@kamiazya/whiteboard-model'
import { LoroDoc, UndoManager } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  deleteCanvasComment,
  deleteSpatialEdge,
  deleteSpatialNode,
  readCoreFacets,
  readEdgeLocks,
  readFacets,
  readNodeLocks,
  readSpatialCanvas,
  setEdgeLock,
  setNodeLock,
  withSpatialBatch,
  writeCanvasComment,
  writeCoreFacets,
  writeDocumentKind,
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

  test('round-trips node with x-whiteboard embed extension', () => {
    const doc = makeDoc()
    const node: SpatialNode = {
      ...TEXT_NODE,
      'x-whiteboard': { kind: 'embed', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' },
    }
    const canvas: SpatialCanvas = { nodes: [node], edges: [] }

    writeSpatialCanvas(doc, canvas)
    const result = readSpatialCanvas(doc)

    expect(result.nodes[0]['x-whiteboard']).toEqual({
      kind: 'embed',
      documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
    })
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
    const facets: ExtensionFacets = { 'example.kanban/v1': { status: 'in-progress' } }

    writeFacets(doc, facets)

    expect(readFacets(doc)).toEqual(facets)
  })

  test('round-trips multiple facet domains', () => {
    const doc = makeDoc()
    const facets: ExtensionFacets = {
      'example.kanban/v1': { status: 'in-progress' },
      'example.priority/v1': { level: 'high' },
    }

    writeFacets(doc, facets)

    expect(readFacets(doc)).toEqual(facets)
  })

  test('merges new facet keys with existing ones on write', () => {
    const doc = makeDoc()

    writeFacets(doc, { 'example.kanban/v1': { status: 'todo' } })
    writeFacets(doc, {
      'example.kanban/v1': { status: 'done' },
      'example.priority/v1': { level: 'low' },
    })

    expect(readFacets(doc)).toEqual({
      'example.kanban/v1': { status: 'done' },
      'example.priority/v1': { level: 'low' },
    })
  })

  test('deletes facet keys absent from a later write', () => {
    const doc = makeDoc()

    writeFacets(doc, {
      'example.kanban/v1': { status: 'todo' },
      'example.priority/v1': { level: 'low' },
    })
    writeFacets(doc, { 'example.kanban/v1': { status: 'todo' } })

    expect(readFacets(doc)).toEqual({ 'example.kanban/v1': { status: 'todo' } })
  })

  test('CRDT merge: two docs add different facet domains', () => {
    const doc1 = new LoroDoc()
    const doc2 = new LoroDoc()

    writeFacets(doc1, { 'example.kanban/v1': { status: 'todo' } })
    writeFacets(doc2, { 'example.priority/v1': { level: 'high' } })

    doc1.import(doc2.export({ mode: 'snapshot' }))

    expect(readFacets(doc1)).toEqual({
      'example.kanban/v1': { status: 'todo' },
      'example.priority/v1': { level: 'high' },
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

  test('ignores a `__proto__` key in the underlying core map instead of throwing', () => {
    // A LoroMap key is a CRDT string, so `__proto__` stores and enumerates
    // like any other — and the doc this reads is untrusted input arriving
    // over sync or import. Looking the key up on a plain-object schema table
    // walks the prototype chain and answers with `Object.prototype`, which is
    // truthy and has no `safeParse`.
    const doc = makeDoc()
    doc.getMap('core').set('__proto__', { polluted: true })
    doc.getMap('core').set('type', 'spatial')
    doc.commit()

    expect(readCoreFacets(doc)).toEqual({ type: 'spatial' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test('does not surface a title an older writer stored in the content', () => {
    // A document's name belongs to the workspace and the OKF `title` is a
    // projection of it (ADR-0009 decision 2), so `core` is not a place a
    // title can live. Documents written before that landed hold one anyway —
    // surfacing it would put the second source of truth straight back into
    // the editor, and the next write would keep it alive.
    const doc = makeDoc()
    doc.getMap('core').set('type', 'note')
    doc.getMap('core').set('title', 'Copied from the workspace name')
    doc.commit()

    expect(readCoreFacets(doc)).toEqual({ type: 'note' })
  })

  test('a spatial document reports no facets, whatever its core map still holds', () => {
    // A facet is OKF frontmatter and JSON Canvas has none (ADR-0009
    // decision 3). Documents written before that stopped being true carry
    // one anyway; surfacing it puts frontmatter on a diagram that no
    // exporter of that format can round-trip.
    const doc = makeDoc()
    writeCoreFacets(doc, { type: 'diagram', tags: ['stale'] })
    writeDocumentKind(doc, 'spatial')

    expect(readCoreFacets(doc)).toBeUndefined()
  })

  test('a markdown document still reports them, and so does one with no kind', () => {
    const markdown = makeDoc()
    writeCoreFacets(markdown, { type: 'note' })
    writeDocumentKind(markdown, 'markdown')
    expect(readCoreFacets(markdown)).toEqual({ type: 'note' })

    // An absent kind is not evidence of a format, exactly as wb_facet_set
    // treats it.
    const kindless = makeDoc()
    writeCoreFacets(kindless, { type: 'note' })
    expect(readCoreFacets(kindless)).toEqual({ type: 'note' })
  })

  test('a write purges a title an older writer left behind', () => {
    const doc = makeDoc()
    doc.getMap('core').set('type', 'note')
    doc.getMap('core').set('title', 'Copied from the workspace name')
    doc.commit()

    writeCoreFacets(doc, { type: 'note', tags: ['idea'] })

    expect(doc.getMap('core').get('title')).toBeUndefined()
  })

  test('round-trips every core field', () => {
    const doc = makeDoc()
    const meta: StoredCoreFacets = {
      type: 'note',
      tags: ['idea', 'browser'],
      view: 'example.kanban/v1',
      facetsRaw: { customKey: 'value' },
    }

    writeCoreFacets(doc, meta)

    expect(readCoreFacets(doc)).toEqual(meta)
  })

  test('round-trips the minimal (type-only) core meta', () => {
    const doc = makeDoc()
    const meta: StoredCoreFacets = { type: 'canvas' }

    writeCoreFacets(doc, meta)

    expect(readCoreFacets(doc)).toEqual(meta)
  })

  test('a later write replaces the whole document meta: an omitted optional field disappears', () => {
    const doc = makeDoc()

    writeCoreFacets(doc, { type: 'note', view: 'example.kanban/v1', tags: ['a'] })
    writeCoreFacets(doc, { type: 'note' })

    expect(readCoreFacets(doc)).toEqual({ type: 'note' })
  })

  test('writing core meta never touches the extension facets bucket', () => {
    const doc = makeDoc()
    writeFacets(doc, { 'example.kanban/v1': { status: 'todo' } })

    writeCoreFacets(doc, { type: 'note', tags: ['untouched-adjacent'] })

    expect(readFacets(doc)).toEqual({ 'example.kanban/v1': { status: 'todo' } })
  })

  test('writing extension facets never touches the core meta bucket', () => {
    const doc = makeDoc()
    writeCoreFacets(doc, { type: 'note', view: 'example.kanban/v1' })

    writeFacets(doc, { 'example.kanban/v1': { status: 'todo' } })

    expect(readCoreFacets(doc)).toEqual({ type: 'note', view: 'example.kanban/v1' })
  })

  test('CRDT merge: two docs independently write different core-meta fields converge on both', () => {
    const doc1 = new LoroDoc()
    const doc2 = new LoroDoc()

    writeCoreFacets(doc1, { type: 'note' })
    doc2.import(doc1.export({ mode: 'snapshot' }))
    writeCoreFacets(doc1, { type: 'note', view: 'from-doc1' })
    writeCoreFacets(doc2, { type: 'note', tags: ['from-doc2'] })

    doc1.import(doc2.export({ mode: 'snapshot' }))

    const merged = readCoreFacets(doc1)
    expect(merged?.type).toBe('note')
    expect(merged?.view).toBe('from-doc1')
    expect(merged?.tags).toEqual(['from-doc2'])
  })

  test('drops a single corrupt field but keeps the rest when type is still valid', () => {
    const doc = makeDoc()
    doc.getMap('core').set('type', 'note')
    doc.getMap('core').set('view', 'example.kanban/v1')
    doc.getMap('core').set('tags', 'not-an-array')
    doc.commit()

    expect(readCoreFacets(doc)).toEqual({ type: 'note', view: 'example.kanban/v1' })
  })

  test('returns undefined when the required type field is missing or invalid', () => {
    const doc = makeDoc()
    doc.getMap('core').set('view', 'orphan view, no type')
    doc.commit()

    expect(readCoreFacets(doc)).toBeUndefined()
  })
})

// withSpatialBatch (editor-completeness slice 1): N writes inside ONE Loro
// commit — one UndoManager step, with the N=1 path byte-identical to the
// corresponding single committing helper. Spike verdict 2026-08-09 (option
// C); Loro's UndoManager.groupStart()/groupEnd() was considered and
// rejected — a remote import mid-group can split the group, while a single
// commit is indivisible.
describe('withSpatialBatch', () => {
  const seeded = () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })
    return doc
  }

  test('a batch of one writeNode is byte-identical to writeSpatialNode', () => {
    const a = new LoroDoc()
    a.setPeerId(1n)
    const b = new LoroDoc()
    b.setPeerId(1n)
    writeSpatialNode(a, TEXT_NODE)
    withSpatialBatch(b, (w) => w.writeNode(TEXT_NODE))
    expect(b.export({ mode: 'update' })).toEqual(a.export({ mode: 'update' }))
  })

  test('a batch of one writeEdge / deleteNode / deleteEdge each mirrors its helper byte-for-byte', () => {
    const base = new LoroDoc()
    base.setPeerId(9n)
    writeSpatialCanvas(base, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })
    const snapshot = base.export({ mode: 'snapshot' })
    const pair = () => {
      const a = new LoroDoc()
      a.import(snapshot)
      a.setPeerId(1n)
      const b = new LoroDoc()
      b.import(snapshot)
      b.setPeerId(1n)
      return { a, b }
    }

    const edgePair = pair()
    writeSpatialEdge(edgePair.a, { ...EDGE, label: 'renamed' })
    withSpatialBatch(edgePair.b, (w) => w.writeEdge({ ...EDGE, label: 'renamed' }))
    expect(edgePair.b.export({ mode: 'update' })).toEqual(edgePair.a.export({ mode: 'update' }))

    const delNodePair = pair()
    deleteSpatialNode(delNodePair.a, TEXT_NODE.id)
    withSpatialBatch(delNodePair.b, (w) => w.deleteNode(TEXT_NODE.id))
    expect(delNodePair.b.export({ mode: 'update' })).toEqual(
      delNodePair.a.export({ mode: 'update' }),
    )

    const delEdgePair = pair()
    deleteSpatialEdge(delEdgePair.a, EDGE.id)
    withSpatialBatch(delEdgePair.b, (w) => w.deleteEdge(EDGE.id))
    expect(delEdgePair.b.export({ mode: 'update' })).toEqual(
      delEdgePair.a.export({ mode: 'update' }),
    )
  })

  test('deleting an ABSENT id inside a batch preserves the helper no-op: no ops, no undo step', async () => {
    const doc = seeded()
    const undoManager = new UndoManager(doc, { mergeInterval: 0 })
    expect(undoManager.canUndo()).toBe(false)
    withSpatialBatch(doc, (w) => {
      w.deleteNode('ghost')
      w.deleteEdge('ghost-edge')
    })
    expect(undoManager.canUndo()).toBe(false)
    expect(readSpatialCanvas(doc).nodes).toHaveLength(2)
  })

  test('one batch of N writes = exactly one undo step (mergeInterval 0 so timing cannot mask it)', async () => {
    const doc = seeded()
    const before = readSpatialCanvas(doc)
    const undoManager = new UndoManager(doc, { mergeInterval: 0 })
    expect(undoManager.canUndo()).toBe(false)
    withSpatialBatch(doc, (w) => {
      w.writeNode(LINK_NODE)
      w.writeNode(GROUP_NODE)
      w.deleteNode(TEXT_NODE.id)
    })
    expect(
      readSpatialCanvas(doc)
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual(['node-2', 'node-3', 'node-4'].sort())
    undoManager.undo()
    expect(readSpatialCanvas(doc)).toEqual(before)
    expect(undoManager.canUndo()).toBe(false)
  })

  test('error contract: a mid-batch throw commits NOTHING; the partial ops stay pending until a later committing write converges the doc', async () => {
    const doc = seeded()
    const undoManager = new UndoManager(doc, { mergeInterval: 0 })
    expect(() =>
      withSpatialBatch(doc, (w) => {
        w.writeNode(LINK_NODE)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    // Commit is an undo/sync boundary, not a visibility boundary: the
    // partial write IS visible to readers, but no undo step exists.
    expect(undoManager.canUndo()).toBe(false)
    expect(readSpatialCanvas(doc).nodes.map((n) => n.id)).toContain(LINK_NODE.id)
    // The session-layer fallback (writeSpatialCanvas to the intended next
    // state) absorbs the pending ops into ONE converged commit/undo step.
    const next: SpatialCanvas = { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] }
    writeSpatialCanvas(doc, next)
    expect(readSpatialCanvas(doc)).toEqual(next)
    undoManager.undo()
    expect(undoManager.canUndo()).toBe(false)
  })
})

// Node lock (user decisions 2026-08-09): an EDITOR affordance stored in a
// Loro sidecar map so it survives reload and syncs to peers, while never
// reaching an export — `readSpatialCanvas` reads only nodes/edges, so the
// canvas value every export path serializes cannot carry it.
describe('node lock sidecar', () => {
  const seeded = () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })
    return doc
  }

  test('setNodeLock marks and clears a node; readNodeLocks reports the set', () => {
    const doc = seeded()
    expect(readNodeLocks(doc)).toEqual(new Set())

    setNodeLock(doc, TEXT_NODE.id, true)
    expect(readNodeLocks(doc)).toEqual(new Set([TEXT_NODE.id]))

    setNodeLock(doc, FILE_NODE.id, true)
    expect(readNodeLocks(doc)).toEqual(new Set([TEXT_NODE.id, FILE_NODE.id]))

    setNodeLock(doc, TEXT_NODE.id, false)
    expect(readNodeLocks(doc)).toEqual(new Set([FILE_NODE.id]))
  })

  test('the lock never reaches the canvas value exports serialize', () => {
    const doc = seeded()
    setNodeLock(doc, TEXT_NODE.id, true)
    const canvas = readSpatialCanvas(doc)
    // Same node set, and not one node object carries a lock field.
    expect(canvas.nodes.map((node) => node.id).sort()).toEqual([FILE_NODE.id, TEXT_NODE.id].sort())
    for (const node of canvas.nodes) {
      expect(Object.keys(node)).not.toContain('locked')
    }
  })

  test('a full writeSpatialCanvas resync leaves the sidecar intact', () => {
    const doc = seeded()
    setNodeLock(doc, TEXT_NODE.id, true)
    // The resync path every fallback commit takes must not wipe editor state.
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })
    expect(readNodeLocks(doc)).toEqual(new Set([TEXT_NODE.id]))
  })

  test('a resync that OMITS a locked node takes its lock entry with it', () => {
    const doc = seeded()
    setNodeLock(doc, TEXT_NODE.id, true)
    setNodeLock(doc, FILE_NODE.id, true)

    // The resync is the other node-removal path (the editor's fallback
    // commit). Leaving the entry behind would let a reminted id inherit a
    // stranger's lock — the same hazard deleteSpatialNode guards against.
    writeSpatialCanvas(doc, { nodes: [FILE_NODE], edges: [] })
    expect(readNodeLocks(doc)).toEqual(new Set([FILE_NODE.id]))
  })

  test('deleting a node cascades its lock entry away (no orphan accumulation)', () => {
    const doc = seeded()
    setNodeLock(doc, TEXT_NODE.id, true)
    setNodeLock(doc, FILE_NODE.id, true)

    deleteSpatialNode(doc, TEXT_NODE.id)
    expect(readNodeLocks(doc)).toEqual(new Set([FILE_NODE.id]))

    // Same cascade inside a batch.
    withSpatialBatch(doc, (w) => w.deleteNode(FILE_NODE.id))
    expect(readNodeLocks(doc)).toEqual(new Set())
  })

  test('setNodeLock to its current value writes nothing (no empty undo step)', async () => {
    const doc = seeded()
    setNodeLock(doc, TEXT_NODE.id, true)
    const undoManager = new UndoManager(doc, { mergeInterval: 0 })
    expect(undoManager.canUndo()).toBe(false)
    setNodeLock(doc, TEXT_NODE.id, true)
    expect(undoManager.canUndo()).toBe(false)
    setNodeLock(doc, 'never-locked', false)
    expect(undoManager.canUndo()).toBe(false)
  })
})

describe('edge lock sidecar', () => {
  const seeded = () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })
    return doc
  }

  test('setEdgeLock marks and clears an edge; readEdgeLocks reports the set', () => {
    const doc = seeded()
    expect(readEdgeLocks(doc)).toEqual(new Set())

    setEdgeLock(doc, EDGE.id, true)
    expect(readEdgeLocks(doc)).toEqual(new Set([EDGE.id]))
    // Node and edge locks are independent sets, not one shared namespace.
    expect(readNodeLocks(doc)).toEqual(new Set())

    setEdgeLock(doc, EDGE.id, false)
    expect(readEdgeLocks(doc)).toEqual(new Set())
  })

  test('the lock never reaches the canvas value exports serialize', () => {
    const doc = seeded()
    setEdgeLock(doc, EDGE.id, true)
    const canvas = readSpatialCanvas(doc)
    expect(canvas.edges.map((edge) => edge.id)).toEqual([EDGE.id])
    for (const edge of canvas.edges) {
      expect(Object.keys(edge)).not.toContain('locked')
    }
  })

  test('a full writeSpatialCanvas resync leaves the sidecar intact', () => {
    const doc = seeded()
    setEdgeLock(doc, EDGE.id, true)
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [EDGE] })
    expect(readEdgeLocks(doc)).toEqual(new Set([EDGE.id]))
  })

  test('a resync that OMITS a locked edge takes its lock entry with it', () => {
    const doc = seeded()
    setEdgeLock(doc, EDGE.id, true)
    writeSpatialCanvas(doc, { nodes: [TEXT_NODE, FILE_NODE], edges: [] })
    expect(readEdgeLocks(doc)).toEqual(new Set())
  })

  test('deleting an edge cascades its lock entry away', () => {
    const doc = seeded()
    setEdgeLock(doc, EDGE.id, true)
    deleteSpatialEdge(doc, EDGE.id)
    expect(readEdgeLocks(doc)).toEqual(new Set())

    // Same cascade inside a batch.
    writeSpatialEdge(doc, EDGE)
    setEdgeLock(doc, EDGE.id, true)
    withSpatialBatch(doc, (w) => w.deleteEdge(EDGE.id))
    expect(readEdgeLocks(doc)).toEqual(new Set())
  })

  test('deleting a node takes the locks of the edges it cascades away', () => {
    const doc = seeded()
    setEdgeLock(doc, EDGE.id, true)
    // EDGE runs node-1 -> node-2, so deleting either endpoint removes it —
    // and an orphaned lock would be inherited by a reminted edge id.
    deleteSpatialNode(doc, TEXT_NODE.id)
    expect(readSpatialCanvas(doc).edges).toEqual([])
    expect(readEdgeLocks(doc)).toEqual(new Set())
  })

  test('setEdgeLock to its current value writes nothing (no empty undo step)', async () => {
    const doc = seeded()
    setEdgeLock(doc, EDGE.id, true)
    const undoManager = new UndoManager(doc, { mergeInterval: 0 })
    expect(undoManager.canUndo()).toBe(false)
    setEdgeLock(doc, EDGE.id, true)
    expect(undoManager.canUndo()).toBe(false)
    setEdgeLock(doc, 'never-locked', false)
    expect(undoManager.canUndo()).toBe(false)
  })
})

// The reload path in the browser-local app is: snapshot bytes, then a
// REPLAY of incremental update bytes. A lock written after the snapshot
// travels only in those updates, so it has to survive that exact route.
test('a lock written after the snapshot survives snapshot + update replay', () => {
  const origin = makeDoc()
  writeSpatialCanvas(origin, { nodes: [TEXT_NODE, FILE_NODE], edges: [] })
  const snapshot = origin.export({ mode: 'snapshot' })
  const beforeLock = origin.oplogVersion()

  setNodeLock(origin, TEXT_NODE.id, true)
  const updateAfterLock = origin.export({ mode: 'update', from: beforeLock })

  const reloaded = new LoroDoc()
  reloaded.import(snapshot)
  expect(readNodeLocks(reloaded)).toEqual(new Set())
  reloaded.import(updateAfterLock)
  expect(readNodeLocks(reloaded)).toEqual(new Set([TEXT_NODE.id]))
  // And the canvas itself is unchanged by the lock round-trip.
  expect(
    readSpatialCanvas(reloaded)
      .nodes.map((n) => n.id)
      .sort(),
  ).toEqual([FILE_NODE.id, TEXT_NODE.id].sort())
})

// The canvas ENVELOPE, not its contents. Nodes and edges each get a keyed
// map so two peers editing different objects converge; a canvas-wide
// preference is one value with one meaning, so last-writer-wins per key is
// the whole story.
describe('canvas-level extension', () => {
  test('round-trips the routing style', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, {
      nodes: [],
      edges: [],
      'x-whiteboard': { edgeRouting: { style: 'orthogonal' } },
    })

    expect(readSpatialCanvas(doc)['x-whiteboard']).toEqual({
      edgeRouting: { style: 'orthogonal' },
    })
  })

  test('leaves the key absent when the canvas never set one', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, { nodes: [], edges: [] })

    expect(readSpatialCanvas(doc)).not.toHaveProperty('x-whiteboard')
  })

  // Reverting to the default must clear the stored value, or the canvas keeps
  // rendering a preference the user turned off.
  test('clears the stored setting when the canvas drops it', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, {
      nodes: [],
      edges: [],
      'x-whiteboard': { edgeRouting: { style: 'orthogonal' } },
    })
    writeSpatialCanvas(doc, { nodes: [], edges: [] })

    expect(readSpatialCanvas(doc)).not.toHaveProperty('x-whiteboard')
  })

  test('survives a merge from a peer that only moved a node', () => {
    const a = makeDoc()
    writeSpatialCanvas(a, {
      nodes: [TEXT_NODE],
      edges: [],
      'x-whiteboard': { edgeRouting: { style: 'orthogonal' } },
    })
    const b = makeDoc()
    b.import(a.export({ mode: 'snapshot' }))
    writeSpatialCanvas(b, {
      nodes: [{ ...TEXT_NODE, x: 999 }],
      edges: [],
      'x-whiteboard': { edgeRouting: { style: 'orthogonal' } },
    })
    a.import(b.export({ mode: 'snapshot' }))

    expect(readSpatialCanvas(a)['x-whiteboard']?.edgeRouting?.style).toBe('orthogonal')
  })
})

// The annotation layer (ADR-0024). The one property everything below exists
// for: two peers commenting CONCURRENTLY must both survive a merge, which is
// why each comment lives under its own key in a dedicated map rather than
// inside the canvas envelope value (whole-value LWW) or a facet payload
// (replace-whole-payload).
describe('canvas comments bridge', () => {
  const COMMENT: CanvasComment = { id: 'c1', x: 10, y: 20, text: 'this box overlaps' }
  const OTHER: CanvasComment = {
    id: 'c2',
    x: -40,
    y: 5,
    text: 'rename this',
    author: 'human:reviewer',
    createdAt: '2026-09-01T10:00:00+09:00',
    targetNodeId: 'node-1',
    resolved: false,
  }

  test('round-trips comments beside the rendering preferences', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, {
      nodes: [],
      edges: [],
      'x-whiteboard': { edgeRouting: { style: 'orthogonal' }, comments: [COMMENT, OTHER] },
    })

    const result = readSpatialCanvas(doc)
    expect(result['x-whiteboard']?.edgeRouting).toEqual({ style: 'orthogonal' })
    expect((result['x-whiteboard']?.comments ?? []).map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    expect(result['x-whiteboard']?.comments?.find((c) => c.id === 'c2')).toEqual(OTHER)
  })

  test('stores each comment under its own key, never inside the envelope value', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, {
      nodes: [],
      edges: [],
      'x-whiteboard': { edgeRouting: { style: 'orthogonal' }, comments: [COMMENT] },
    })

    // The envelope stays whole-value LWW and must not carry the comments —
    // that is what would reintroduce the concurrent-loss this layout removes.
    expect(doc.getMap('canvas').get('x-whiteboard')).toEqual({
      edgeRouting: { style: 'orthogonal' },
    })
    expect(doc.getMap('comments').keys()).toEqual(['c1'])
  })

  test('CRDT merge: two peers comment concurrently and both survive', () => {
    const base = makeDoc()
    writeSpatialCanvas(base, { nodes: [TEXT_NODE], edges: [] })
    const peer = makeDoc()
    peer.import(base.export({ mode: 'snapshot' }))

    writeCanvasComment(base, COMMENT)
    writeCanvasComment(peer, OTHER)
    base.import(peer.export({ mode: 'snapshot' }))

    const merged = readSpatialCanvas(base)['x-whiteboard']?.comments ?? []
    expect(merged.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
  })

  test('a full resync deletes the comments the canvas no longer carries', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, {
      nodes: [],
      edges: [],
      'x-whiteboard': { comments: [COMMENT, OTHER] },
    })
    writeSpatialCanvas(doc, { nodes: [], edges: [], 'x-whiteboard': { comments: [OTHER] } })

    expect(readSpatialCanvas(doc)['x-whiteboard']?.comments).toEqual([OTHER])
  })

  test('writeCanvasComment leaves every other comment untouched; delete removes exactly one', () => {
    const doc = makeDoc()
    writeSpatialCanvas(doc, { nodes: [], edges: [], 'x-whiteboard': { comments: [COMMENT] } })

    writeCanvasComment(doc, OTHER)
    expect(readSpatialCanvas(doc)['x-whiteboard']?.comments).toHaveLength(2)

    deleteCanvasComment(doc, 'c1')
    expect(readSpatialCanvas(doc)['x-whiteboard']?.comments).toEqual([OTHER])

    // Absent id: a no-op, no commit — matching the bridge convention.
    deleteCanvasComment(doc, 'never-existed')
    expect(readSpatialCanvas(doc)['x-whiteboard']?.comments).toEqual([OTHER])
  })

  test('a corrupt stored comment is dropped on read, never the whole layer', () => {
    const doc = makeDoc()
    writeCanvasComment(doc, COMMENT)
    doc.getMap('comments').set('bad', { nope: true })
    doc.commit()

    expect(readSpatialCanvas(doc)['x-whiteboard']?.comments).toEqual([COMMENT])
  })

  test('refuses a non-finite anchor loudly, matching the node geometry guard', () => {
    const doc = makeDoc()
    expect(() => writeCanvasComment(doc, { ...COMMENT, x: Number.NaN })).toThrow(TypeError)
  })

  test('comments alone produce an extension; no comments and no envelope produce none', () => {
    const doc = makeDoc()
    writeCanvasComment(doc, COMMENT)
    expect(readSpatialCanvas(doc)['x-whiteboard']).toEqual({ comments: [COMMENT] })

    deleteCanvasComment(doc, 'c1')
    expect(readSpatialCanvas(doc)).not.toHaveProperty('x-whiteboard')
  })
})
