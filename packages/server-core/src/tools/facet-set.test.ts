import { createFacetRegistry, defineFacet, definePlugin } from '@kamiazya/whiteboard-facet-engine'
import {
  readCoreFacets,
  readDocumentKind,
  readFacets,
  readSpatialCanvas,
  writeCoreFacets,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { bundledPlugins } from '@kamiazya/whiteboard-plugin-visual'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { DocumentKindMismatchError, FacetWriteRejectedError, NodeNotFoundError } from './errors.js'
import {
  createFacetSetTool,
  DocumentHasNoFrontmatterError,
  FacetSetNeedsPayloadError,
  facetSetInputSchema,
  NodeAndCanvasTargetError,
  NodeAndEdgeTargetError,
  NodeTargetNeedsOneDocumentError,
  TagsTargetDocumentError,
} from './facet-set.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore): ServerDeps {
  return makeTestDeps({
    documentStore: documentStore,
    documentIndex: documentStore.documentIndex,
  })
}

describe('wb_facet_set tool', () => {
  test('sets a facet on a canvas with no prior snapshot', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(documentStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })

    expect(result).toEqual({
      updated: [{ documentId: DOCUMENT_ID, facets: { 'example.kanban/v1': { status: 'todo' } } }],
    })
  })

  test('persists the facet so a later load reflects it', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })

    const loaded = await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    expect(loaded).not.toBeNull()
    const doc = new LoroDoc()
    if (loaded !== null) {
      doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
    }
    expect(readFacets(doc)).toEqual({ 'example.kanban/v1': { status: 'todo' } })
  })

  test('merges a new facet domain with an existing one instead of replacing it', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(documentStore))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.priority/v1': { level: 'high' } },
    })

    expect(result.updated[0]?.facets).toEqual({
      'example.kanban/v1': { status: 'todo' },
      'example.priority/v1': { level: 'high' },
    })
  })

  test('overwrites an existing facet domain when the same key is set again', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(documentStore))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.kanban/v1': { status: 'done' } },
    })

    expect(result.updated[0]?.facets).toEqual({ 'example.kanban/v1': { status: 'done' } })
  })

  test('throws WorkspaceDocumentNotFoundError when workspaceId does not actually own documentId', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        workspaceId: 'ws-other',
        documentIds: [DOCUMENT_ID],
        facets: { 'example.kanban/v1': { status: 'todo' } },
      }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })

  test('rejects a facet key outside the {namespace}.{name}/v{n} pattern', () => {
    expect(() =>
      facetSetInputSchema.parse({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        facets: { title: 'not an extension facet' },
      }),
    ).toThrow()
  })
})

describe('facets belong to OKF (ADR-0009 decision 3)', () => {
  test('refuses a spatial document', async () => {
    // A facet is OKF frontmatter. A JSON Canvas document has nodes and edges
    // and no frontmatter to put one in, so a facet stored on one is metadata
    // no reader of that format can ever surface.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'n' }],
        edges: [],
      })
    })

    await expect(
      createFacetSetTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        facets: { 'example.sample/v1': { status: 'open' } },
      }),
    ).rejects.toThrow(DocumentKindMismatchError)
  })

  test('a refused write stores nothing', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => writeDocumentKind(doc, 'spatial'))

    await expect(
      createFacetSetTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        facets: { 'example.sample/v1': { status: 'open' } },
      }),
    ).rejects.toThrow(DocumentKindMismatchError)

    const snap = await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    const doc = new LoroDoc()
    if (snap) doc.import(reassembleSnapshot(snap.manifest, snap.chunks))
    expect(readFacets(doc)).toEqual({})
  })

  test('a markdown document still takes facets', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => writeDocumentKind(doc, 'markdown'))

    const result = await createFacetSetTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.sample/v1': { status: 'open' } },
    })

    expect(result.updated[0]?.facets).toEqual({ 'example.sample/v1': { status: 'open' } })
  })
})

describe('registered-facet validation (ADR-0013 decision 6)', () => {
  const documentTicket = definePlugin({
    id: 'ticket',
    displayName: 'Ticket',
    facets: [
      defineFacet({
        name: 'sample',
        displayName: 'Sample',
        version: 'v0',
        targets: ['document'],
        schema: z.object({ status: z.enum(['open', 'done']) }),
      }),
    ],
  })
  const registry = createFacetRegistry([...bundledPlugins, documentTicket])

  async function setupWith(registryOverride = registry) {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool({ ...makeDeps(documentStore), facetRegistry: registryOverride })
    return tool
  }

  test('accepts a registered facet with a valid payload', async () => {
    const tool = await setupWith()
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'ticket.sample/v0': { status: 'open' } },
    })
    expect(result.updated[0]?.facets).toEqual({ 'ticket.sample/v0': { status: 'open' } })
  })

  test('rejects a registered facet with an invalid payload, storing nothing', async () => {
    const tool = await setupWith()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        facets: { 'ticket.sample/v0': { status: 'nope' } },
      }),
    ).rejects.toThrow(FacetWriteRejectedError)
  })

  test('rejects a write to a registered facet under a non-current version key', async () => {
    const tool = await setupWith()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        facets: { 'ticket.sample/v3': { status: 'open' } },
      }),
    ).rejects.toThrow(/ticket\.sample\/v0/)
  })

  test('accepts visual.symbol on a markdown document, now that it targets one', async () => {
    // The markdown half of "a document wears a symbol" is writable through
    // this tool the moment the facet declares the target. The SPATIAL half
    // is not: a symbol on a canvas is a canvas-target write, which this
    // tool has no path for (see the rejection below, and the message it
    // carries).
    const tool = await setupWith()
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'visual.symbol/v0': { kind: 'emoji', char: '📌' } },
    })
    expect(result.updated[0]?.facets).toEqual({ 'visual.symbol/v0': { kind: 'emoji', char: '📌' } })
  })

  test('still refuses a symbol payload the schema rejects', async () => {
    const tool = await setupWith()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        // Two graphemes is not a badge.
        facets: { 'visual.symbol/v0': { kind: 'emoji', char: '✅🔥' } },
      }),
    ).rejects.toThrow(FacetWriteRejectedError)
  })

  test("rejects a canvas-target facet on a document (targets are the definition's to declare)", async () => {
    const tool = await setupWith()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        facets: { 'visual.edges/v0': { routing: 'curved' } },
      }),
    ).rejects.toThrow(/canvas/)
  })

  test('still passes an unregistered facet through unvalidated', async () => {
    const tool = await setupWith()
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'someone.else/v9': { anything: ['goes'] } },
    })
    expect(result.updated[0]?.facets).toEqual({ 'someone.else/v9': { anything: ['goes'] } })
  })

  test('the bundled registry is the default when deps carry none', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(documentStore))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        facets: { 'visual.edges/v0': { routing: 'spiral' } },
      }),
    ).rejects.toThrow(FacetWriteRejectedError)
  })
})

describe('node-target writes (nodeId)', () => {
  const spatialWith = async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(documentStore, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', text: 'hi', x: 0, y: 0, width: 100, height: 50 }],
        edges: [],
      })
    })
    return { documentStore, tool: createFacetSetTool(makeDeps(documentStore)) }
  }

  const spatialWithEdge = async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(documentStore, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [
          { id: 'n1', type: 'text', text: 'a', x: 0, y: 0, width: 100, height: 50 },
          { id: 'n2', type: 'text', text: 'b', x: 300, y: 200, width: 100, height: 50 },
        ],
        edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
      })
    })
    return { documentStore, tool: createFacetSetTool(makeDeps(documentStore)) }
  }

  test('sets a node-target facet into the node x-whiteboard facets bucket', async () => {
    const { documentStore, tool } = await spatialWith()
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      nodeId: 'n1',
      facets: { 'visual.shape/v0': { kind: 'hexagon' } },
    })
    expect(result.updated[0]?.facets).toEqual({ 'visual.shape/v0': { kind: 'hexagon' } })

    const loaded = await documentStore.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    expect(loaded).not.toBeNull()
    const doc = new LoroDoc()
    if (loaded !== null) doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
    const canvas = readSpatialCanvas(doc)
    expect(canvas?.nodes[0]?.['x-whiteboard']).toEqual({
      facets: { 'visual.shape/v0': { kind: 'hexagon' } },
    })
  })

  test('a null payload deletes the facet from the node', async () => {
    const { tool } = await spatialWith()
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      nodeId: 'n1',
      facets: { 'visual.shape/v0': { kind: 'diamond' } },
    })
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      nodeId: 'n1',
      facets: { 'visual.shape/v0': null },
    })
    expect(result.updated[0]?.facets).toEqual({})
  })

  test('rejects a registered facet whose targets exclude node', async () => {
    // visual.edges is canvas-target in the bundled registry, so a node
    // write must refuse it — the same inverted-constraint rule, from the
    // other side.
    const { tool } = await spatialWith()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        nodeId: 'n1',
        facets: { 'visual.edges/v0': { routing: 'curved' } },
      }),
    ).rejects.toThrow(/targets a node/)
  })

  test('sets an edge-target facet into the edge x-whiteboard facets bucket', async () => {
    const { documentStore, tool } = await spatialWithEdge()
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      edgeId: 'e1',
      facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
    })
    expect(result.updated[0]?.facets).toEqual({ 'visual.edges/v0': { routing: 'orthogonal' } })

    const loaded = await documentStore.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    expect(loaded).not.toBeNull()
    const doc = new LoroDoc()
    if (loaded !== null) doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
    const canvas = readSpatialCanvas(doc)
    expect(canvas?.edges[0]?.['x-whiteboard']).toEqual({
      facets: { 'visual.edges/v0': { routing: 'orthogonal' } },
    })
    // The nodes beside it are untouched — the write names one edge.
    expect(canvas?.nodes[0]?.['x-whiteboard']).toBeUndefined()
  })

  test('a null payload deletes the facet from the edge, leaving no empty extension', async () => {
    const { documentStore, tool } = await spatialWithEdge()
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      edgeId: 'e1',
      facets: { 'visual.edges/v0': { routing: 'curved' } },
    })
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      edgeId: 'e1',
      facets: { 'visual.edges/v0': null },
    })
    expect(result.updated[0]?.facets).toEqual({})

    const loaded = await documentStore.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    const doc = new LoroDoc()
    if (loaded !== null) doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
    expect(readSpatialCanvas(doc)?.edges[0]).not.toHaveProperty('x-whiteboard')
  })

  test('rejects a registered facet whose targets exclude edge', async () => {
    const { tool } = await spatialWithEdge()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        edgeId: 'e1',
        facets: { 'visual.shape/v0': { kind: 'hexagon' } },
      }),
    ).rejects.toThrow(/targets an edge/)
  })

  test('rejects an edgeId the canvas does not have', async () => {
    const { tool } = await spatialWithEdge()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        edgeId: 'missing',
        facets: { 'visual.edges/v0': { routing: 'curved' } },
      }),
    ).rejects.toThrow(/missing/)
  })

  test('refuses nodeId and edgeId together: a write lands on one object', async () => {
    const { tool } = await spatialWithEdge()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        nodeId: 'n1',
        edgeId: 'e1',
        facets: { 'visual.edges/v0': { routing: 'curved' } },
      }),
    ).rejects.toBeInstanceOf(NodeAndEdgeTargetError)
  })

  test('rejects nodeId on a markdown document', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(documentStore, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
    })
    const tool = createFacetSetTool(makeDeps(documentStore))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        nodeId: 'n1',
        facets: { 'visual.shape/v0': { kind: 'hexagon' } },
      }),
    ).rejects.toThrow(DocumentKindMismatchError)
  })

  test('a nodeId write against a kind-less document reports the node missing, not a fabricated kind', async () => {
    // A freshly created document has no declared kind and therefore no
    // canvas — the honest answer is "that node does not exist here", never
    // "is a markdown document" about a document that declared nothing.
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(documentStore, DOCUMENT_ID, () => {})
    const tool = createFacetSetTool(makeDeps(documentStore))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        nodeId: 'n1',
        facets: { 'visual.shape/v0': { kind: 'hexagon' } },
      }),
    ).rejects.toThrow(NodeNotFoundError)
  })

  test('rejects a nodeId the canvas does not have', async () => {
    const { tool } = await spatialWith()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        nodeId: 'missing',
        facets: { 'visual.shape/v0': { kind: 'hexagon' } },
      }),
    ).rejects.toThrow(/missing/)
  })
})

describe('null deletes on the document path', () => {
  test('removes the facet and leaves the others', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(documentStore))
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.kanban/v1': { status: 'todo' }, 'example.priority/v1': { level: 'high' } },
    })
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.kanban/v1': null },
    })
    expect(result.updated[0]?.facets).toEqual({ 'example.priority/v1': { level: 'high' } })
  })
})

describe('several documents in one call', () => {
  const SECOND_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'

  test('applies the same facets to every document, in the order asked for', async () => {
    // Axis B: tagging N documents cost N calls, because the tool took one
    // `documentId`. The facets are shared rather than per document — "tag
    // these as reviewed" is the thing a caller is actually doing, and two
    // different payloads are two different writes.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await registerDocumentInWorkspace(store, WORKSPACE_ID, SECOND_ID, 'second')
    const tool = createFacetSetTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID, SECOND_ID],
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })

    expect(result.updated.map((entry) => entry.documentId)).toEqual([DOCUMENT_ID, SECOND_ID])
    expect(result.updated.map((entry) => entry.facets)).toEqual([
      { 'example.kanban/v1': { status: 'todo' } },
      { 'example.kanban/v1': { status: 'todo' } },
    ])
  })

  test('one document outside the workspace writes NOTHING, not a prefix', async () => {
    // The payoff of checking every document before writing any. Without it
    // the first document is tagged and the call still throws, so a caller
    // reading the error has no way to know part of the batch landed.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID, SECOND_ID],
        facets: { 'example.kanban/v1': { status: 'todo' } },
      }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)

    const after = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: {},
    })
    expect(after.updated[0]?.facets).toEqual({})
  })

  test('a nodeId names a node of ONE document, so it refuses a batch', async () => {
    // `nodeId` narrows to a node INSIDE a document. Two documents do not
    // share a node id space, so "this node of these five documents" names
    // nothing — better refused at the schema than applied to whichever
    // documents happen to have a node by that name.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await registerDocumentInWorkspace(store, WORKSPACE_ID, SECOND_ID, 'second')
    const tool = createFacetSetTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID, SECOND_ID],
        nodeId: 'n1',
        facets: {},
      }),
    ).rejects.toThrow(NodeTargetNeedsOneDocumentError)
  })
})

describe('wb_facet_set canvas target (ADR-0030)', () => {
  const THEME_KEY = 'visual.theme/v0'

  async function spatialStore() {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, {
        nodes: [{ id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'hi' }],
        edges: [],
      })
    })
    return store
  }

  test("target: 'canvas' writes a canvas-target facet into the canvas envelope", async () => {
    const store = await spatialStore()
    const tool = createFacetSetTool(makeDeps(store))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      target: 'canvas',
      facets: { [THEME_KEY]: { theme: 'visual.neon' } },
    })
    expect(result).toEqual({
      updated: [{ documentId: DOCUMENT_ID, facets: { [THEME_KEY]: { theme: 'visual.neon' } } }],
    })
    const loaded = await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(loaded!.manifest, loaded!.chunks))
    expect(readSpatialCanvas(doc)['x-whiteboard']?.facets).toEqual({
      [THEME_KEY]: { theme: 'visual.neon' },
    })
  })

  test('deleting the last canvas facet removes the bucket and the empty envelope', async () => {
    const store = await spatialStore()
    const tool = createFacetSetTool(makeDeps(store))
    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      target: 'canvas',
      facets: { [THEME_KEY]: { theme: 'visual.sketch' } },
    })
    const cleared = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      target: 'canvas',
      facets: { [THEME_KEY]: null },
    })
    expect(cleared.updated[0]?.facets).toEqual({})
    const loaded = await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(loaded!.manifest, loaded!.chunks))
    expect(readSpatialCanvas(doc)['x-whiteboard']).toBeUndefined()
  })

  test('refuses a theme id no plugin registered, naming what is', async () => {
    const store = await spatialStore()
    const tool = createFacetSetTool(makeDeps(store))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        target: 'canvas',
        facets: { [THEME_KEY]: { theme: 'visual.chalk' } },
      }),
    ).rejects.toThrow(/visual\.sketch/)
  })

  test("a canvas-target facet without target: 'canvas' is refused by its targets", async () => {
    const store = await spatialStore()
    const tool = createFacetSetTool(makeDeps(store))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        facets: { [THEME_KEY]: { theme: 'visual.neon' } },
      }),
    ).rejects.toThrow(FacetWriteRejectedError)
  })

  test("target: 'canvas' on a markdown document is a kind mismatch", async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
    })
    const tool = createFacetSetTool(makeDeps(store))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        target: 'canvas',
        facets: { [THEME_KEY]: { theme: 'visual.neon' } },
      }),
    ).rejects.toThrow(DocumentKindMismatchError)
  })

  test("target: 'canvas' on a kind-less document writes the envelope and declares nothing", async () => {
    // The same stance the document branch takes on a fresh document: the
    // write replaces nothing, so it neither fails nor guesses a kind — and
    // the message can never read "is a markdown document" about a document
    // that declared none.
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, () => {})
    const tool = createFacetSetTool(makeDeps(store))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      target: 'canvas',
      facets: { [THEME_KEY]: { theme: 'visual.neon' } },
    })
    expect(result.updated[0]?.facets).toEqual({ [THEME_KEY]: { theme: 'visual.neon' } })
    const loaded = await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(loaded!.manifest, loaded!.chunks))
    expect(readDocumentKind(doc)).toBeUndefined()
    expect(readSpatialCanvas(doc)['x-whiteboard']?.facets).toEqual({
      [THEME_KEY]: { theme: 'visual.neon' },
    })
  })

  test('nodeId and a canvas target together name two things at once and are refused', async () => {
    const store = await spatialStore()
    const tool = createFacetSetTool(makeDeps(store))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        nodeId: 'n1',
        target: 'canvas',
        facets: {},
      }),
    ).rejects.toThrow(NodeAndCanvasTargetError)
  })
})

describe('tags (OKF core), the errand a caller is usually doing', () => {
  async function reload(store: FakeDocumentStore): Promise<LoroDoc> {
    const loaded = await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    })
    if (loaded === null) throw new Error('nothing stored')
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
    return doc
  }

  async function markdownWithTags(tags: string[]): Promise<FakeDocumentStore> {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
      writeCoreFacets(doc, { type: 'note', tags })
    })
    return store
  }

  test('add appends what is missing and keeps the rest; remove drops by name', async () => {
    const store = await markdownWithTags(['retro', 'draft'])
    const tool = createFacetSetTool(makeDeps(store))
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      tags: { add: ['archived', 'retro'], remove: ['draft'] },
    })
    expect(result.updated[0]?.tags).toEqual(['retro', 'archived'])
    const stored = await reload(store)
    expect(readCoreFacets(stored)?.tags).toEqual(['retro', 'archived'])
    // The core `type` the write did not mention is still there.
    expect(readCoreFacets(stored)?.type).toBe('note')
  })

  test('tags and facets can travel in one call, and facets alone still work', async () => {
    const store = await markdownWithTags([])
    const tool = createFacetSetTool(makeDeps(store))
    const both = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      tags: { add: ['reviewed'] },
      facets: { 'example.kanban/v1': { status: 'done' } },
    })
    expect(both.updated[0]).toEqual({
      documentId: DOCUMENT_ID,
      facets: { 'example.kanban/v1': { status: 'done' } },
      tags: ['reviewed'],
    })
    const facetsOnly = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.kanban/v1': null },
    })
    expect(facetsOnly.updated[0]).toEqual({ documentId: DOCUMENT_ID, facets: {} })
    expect(readCoreFacets(await reload(store))?.tags).toEqual(['reviewed'])
  })

  test('a call with neither tags nor facets is refused, not silently a no-op', async () => {
    const store = await markdownWithTags([])
    await expect(
      createFacetSetTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
      }),
    ).rejects.toThrow(FacetSetNeedsPayloadError)
  })

  test('an empty tags object is refused by the schema, not saved as a no-op', () => {
    const parsed = facetSetInputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      tags: {},
    })
    expect(parsed.success).toBe(false)
    expect(
      facetSetInputSchema.safeParse({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        tags: { remove: ['x'] },
      }).success,
    ).toBe(true)
  })

  test('tags belong to a document, so nodeId and tags together are refused', async () => {
    const store = await markdownWithTags([])
    await expect(
      createFacetSetTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        nodeId: 'n1',
        tags: { add: ['x'] },
      }),
    ).rejects.toThrow(TagsTargetDocumentError)
  })

  test('a spatial document has no frontmatter to tag', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => writeDocumentKind(doc, 'spatial'))
    await expect(
      createFacetSetTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        tags: { add: ['x'] },
      }),
    ).rejects.toThrow(DocumentKindMismatchError)
  })

  test('a markdown document with no frontmatter yet is told where a tag would go', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    await seedDoc(store, DOCUMENT_ID, (doc) => writeDocumentKind(doc, 'markdown'))
    await expect(
      createFacetSetTool(makeDeps(store)).execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [DOCUMENT_ID],
        tags: { add: ['x'] },
      }),
    ).rejects.toThrow(DocumentHasNoFrontmatterError)
  })

  test('the tool tells a model it tags, by name', () => {
    const tool = createFacetSetTool(makeDeps(new FakeDocumentStore()))
    expect(tool.description).toMatch(/\btags?\b/)
  })
})

describe('wb_facet_set and a workspace stencil library', () => {
  // The same cost decision `wb_canvas_edit` makes, pinned the same way.
  // A library can only change which STENCIL ASSETS are registered, so a
  // write that names no stencil-ref field gets an identical answer from the
  // deployment's registry — and must not pay a document listing for it.
  //
  // Asked of the REGISTRY rather than of a hardcoded `visual.stencil/v0`:
  // which facets take a stencil is a plugin's declaration, and a server that
  // spells one plugin's key cannot be a server other plugins extend.
  test('lists no documents when the batch names no facet that takes a stencil', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'markdown')
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    let listings = 0
    const listDocuments = store.documentIndex.listDocuments.bind(store.documentIndex)
    store.documentIndex.listDocuments = (arg) => {
      listings += 1
      return listDocuments(arg)
    }
    const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })

    await createFacetSetTool(deps).execute({
      workspaceId: WORKSPACE_ID,
      documentIds: [DOCUMENT_ID],
      facets: { 'example.kanban/v1': { status: 'todo' } },
    } as never)

    expect(listings).toBe(0)
  })
})
