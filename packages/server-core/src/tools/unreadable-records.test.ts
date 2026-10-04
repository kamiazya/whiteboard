import {
  readCoreFacets,
  readDocumentKind,
  readFacets,
  readSpatialCanvas,
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeSpatialCanvas,
  writeTrustFacets,
} from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { loadDocument } from '../document-io.js'
import { setLogSink } from '../log.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { createFacetSetTool } from './facet-set.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

// A newer client writes a field this daemon's strict schema does not know.
// The keeper cannot read such a record, and every edit it makes writes back
// what it CAN read, so what a save does to the records it skipped is the
// whole question: a deletion here is a CRDT op that ships to every replica.
function plantUnreadableRecords(doc: LoroDoc): void {
  doc.getMap('nodes').set('future-node', {
    id: 'future-node',
    type: 'text',
    text: 'written by a newer client',
    x: 900,
    y: 900,
    width: 100,
    height: 50,
    fieldFromTheFuture: { nested: 1 },
  })
  doc.getMap('edges').set('future-edge', {
    id: 'future-edge',
    from: { node: 'a' },
    to: { node: 'b' },
    fieldFromTheFuture: 1,
  })
  doc.getMap('lines').set('future-line', {
    id: 'future-line',
    from: { kind: 'point', point: { x: 0, y: 0 } },
    to: { kind: 'point', point: { x: 5, y: 5 } },
    fieldFromTheFuture: 1,
  })
  doc.commit()
}

async function seed(): Promise<FakeDocumentStore> {
  const store = new FakeDocumentStore()
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, {
      nodes: [
        textNode({ id: 'a', text: 'a', x: 0, y: 0, width: 100, height: 50 }),
        textNode({ id: 'b', text: 'b', x: 300, y: 0, width: 100, height: 50 }),
      ],
      edges: [{ id: 'e-ok', from: { node: 'a' }, to: { node: 'b' } }],
    })
    plantUnreadableRecords(doc)
    // The subject is present: a fixture whose planted records the reader
    // happens to accept would pass every assertion below for nothing.
    const read = readSpatialCanvas(doc)
    expect(read.nodes.map((n) => n.id)).not.toContain('future-node')
    expect(read.edges.map((e) => e.id)).not.toContain('future-edge')
    expect(read.lines ?? []).toEqual([])
  })
  return store
}

async function stored(store: FakeDocumentStore): Promise<LoroDoc> {
  const loaded = await store.loadSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
  })
  if (loaded === null) throw new Error('nothing stored')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
  expect(readDocumentKind(doc)).toBe('spatial')
  return doc
}

const keys = (doc: LoroDoc, map: 'nodes' | 'edges' | 'lines'): string[] =>
  Object.keys(doc.getMap(map).toJSON()).sort()

function expectSurvivors(doc: LoroDoc): void {
  expect(keys(doc, 'nodes')).toContain('future-node')
  expect(keys(doc, 'edges')).toContain('future-edge')
  expect(keys(doc, 'lines')).toContain('future-line')
}

describe('a keeper edit leaves the records its reader could not parse', () => {
  test('wb_canvas_edit adding a node keeps an unreadable node, edge and line', async () => {
    const store = await seed()
    const tool = createCanvasEditTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: { type: 'text', id: 'added', x: 0, y: 200, width: 100, height: 40, text: 'new' },
        },
      ],
    })

    const after = await stored(store)
    expect(keys(after, 'nodes')).toContain('added')
    expectSurvivors(after)
  })

  test('wb_canvas_edit adding a line keeps what it could not read, and the line lands', async () => {
    const store = await seed()
    const tool = createCanvasEditTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'line.add',
          line: {
            id: 'drawn',
            from: { kind: 'point', point: { x: 1, y: 1 } },
            to: { kind: 'point', point: { x: 9, y: 9 } },
          },
        },
      ],
    })

    const after = await stored(store)
    expect(keys(after, 'lines')).toEqual(['drawn', 'future-line'])
    expectSurvivors(after)
  })

  test('wb_canvas_edit keeps the canvas own tags and facets, which no op reaches', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [],
        edges: [],
        tags: ['architecture'],
        facets: { 'visual.canvas/v0': { grid: true } },
      })
    })
    const tool = createCanvasEditTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: { type: 'text', id: 'added', x: 0, y: 0, width: 100, height: 40, text: 'new' },
        },
      ],
    })

    const after = readSpatialCanvas(await stored(store))
    expect(after.tags).toEqual(['architecture'])
    expect(after.facets).toEqual({ 'visual.canvas/v0': { grid: true } })
  })

  test('wb_canvas_edit removing a node still removes what the reader could see', async () => {
    const store = await seed()
    const tool = createCanvasEditTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.remove', id: 'b' }],
    })

    const after = await stored(store)
    expect(keys(after, 'nodes')).not.toContain('b')
    expect(keys(after, 'edges')).not.toContain('e-ok')
    expect(keys(after, 'nodes')).toContain('future-node')
  })

  test('wb_facet_set on a node keeps an unreadable node, edge and line', async () => {
    const store = await seed()
    const tool = createFacetSetTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      nodeId: 'a',
      tags: { add: ['urgent'] },
    })

    const after = await stored(store)
    expect(readSpatialCanvas(after).nodes.find((n) => n.id === 'a')?.tags).toEqual(['urgent'])
    expectSurvivors(after)
  })

  test('wb_facet_set on an edge keeps an unreadable node, edge and line', async () => {
    const store = await seed()
    const tool = createFacetSetTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      edgeId: 'e-ok',
      tags: { add: ['urgent'] },
    })

    const after = await stored(store)
    expect(readSpatialCanvas(after).edges.find((e) => e.id === 'e-ok')?.tags).toEqual(['urgent'])
    expectSurvivors(after)
  })

  test('wb_facet_set on the canvas keeps an unreadable node, edge and line', async () => {
    const store = await seed()
    const tool = createFacetSetTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      target: 'canvas',
      tags: { add: ['urgent'] },
    })

    const after = await stored(store)
    expect(readSpatialCanvas(after).tags).toEqual(['urgent'])
    expectSurvivors(after)
  })
})

// The three envelope buckets hold entries a newer client wrote and this
// build's readers drop: a core field the schema does not know, a facet key
// outside the grammar, a trust field of a later family. A write that states
// the bucket from what the reader saw would delete each one.
function plantUnreadableEnvelope(doc: LoroDoc): void {
  doc.getMap('core').set('futureCoreField', { nested: 1 })
  doc.getMap('facets').set('Bad Key', { from: 'the future' })
  doc.getMap('trust').set('futureTrustField', 'kept')
  doc.commit()
}

async function seedMarkdown(): Promise<FakeDocumentStore> {
  const store = new FakeDocumentStore()
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeCoreFacets(doc, { type: 'note', tags: ['kept'] })
    writeFacets(doc, { 'example.kanban/v1': { status: 'todo' } })
    writeTrustFacets(doc, { generated: { by: 'someone', at: '2026-01-01T00:00:00Z' } })
    plantUnreadableEnvelope(doc)
    expect(readCoreFacets(doc)).toEqual({ type: 'note', tags: ['kept'] })
    expect(Object.keys(readFacets(doc))).toEqual(['example.kanban/v1'])
  })
  return store
}

async function storedDocument(store: FakeDocumentStore): Promise<LoroDoc> {
  const loaded = await store.loadSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
  })
  if (loaded === null) throw new Error('nothing stored')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
  return doc
}

describe('a keeper edit leaves the envelope entries its reader could not parse', () => {
  test('wb_facet_set tags and facets on a document keep an unknown core field, facet key and trust field', async () => {
    const store = await seedMarkdown()
    const tool = createFacetSetTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      tags: { add: ['urgent'] },
      facets: { 'example.kanban/v1': { status: 'done' } },
    })

    const after = await storedDocument(store)
    expect(readCoreFacets(after)?.tags).toEqual(['kept', 'urgent'])
    expect(readFacets(after)).toEqual({ 'example.kanban/v1': { status: 'done' } })
    expect(after.getMap('core').get('futureCoreField')).toEqual({ nested: 1 })
    expect(after.getMap('facets').get('Bad Key')).toEqual({ from: 'the future' })
    expect(after.getMap('trust').get('futureTrustField')).toBe('kept')
  })

  test('wb_facet_set deleting a facet and every tag still removes what the reader could see', async () => {
    const store = await seedMarkdown()
    const tool = createFacetSetTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      tags: { remove: ['kept'] },
      facets: { 'example.kanban/v1': null },
    })

    const after = await storedDocument(store)
    expect(readCoreFacets(after)).toEqual({ type: 'note' })
    expect(readFacets(after)).toEqual({})
    expect(after.getMap('core').get('futureCoreField')).toEqual({ nested: 1 })
    expect(after.getMap('facets').get('Bad Key')).toEqual({ from: 'the future' })
  })

  test('wb_facet_set on the canvas keeps a valid facet read beside an out-of-grammar key', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [],
        edges: [],
        facets: { 'visual.theme/v0': { theme: 'visual.neon' } },
      })
      doc.getMap('canvas').set('facets', {
        'visual.theme/v0': { theme: 'visual.neon' },
        'Bad Key': { from: 'the future' },
      })
      doc.commit()
      // The subject is present: the stored bucket holds a key outside the grammar.
      expect(Object.keys(doc.getMap('canvas').get('facets') as object)).toContain('Bad Key')
    })
    const tool = createFacetSetTool(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      target: 'canvas',
      facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
    })

    const after = await storedDocument(store)
    expect(after.getMap('canvas').get('facets')).toEqual({
      'visual.theme/v0': { theme: 'visual.neon' },
      'visual.edges/v0': { routing: 'orthogonal' },
      'Bad Key': { from: 'the future' },
    })
  })
})

describe('loading a canvas that holds unreadable records', () => {
  test('says how many were left out, and where, without failing the load', async () => {
    const store = await seed()
    const records: { level: string; msg: string; data?: Record<string, unknown> }[] = []
    setLogSink(({ level, msg, data }) => records.push({ level, msg, ...(data && { data }) }))
    try {
      const { canvas } = await loadDocument(
        makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
        WORKSPACE_ID,
        DOCUMENT_ID,
      )
      expect(canvas.nodes.map((node) => node.id).sort()).toEqual(['a', 'b'])
    } finally {
      setLogSink(() => {})
    }

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: 'warning',
      data: { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, skipped: 3 },
    })
  })
})
