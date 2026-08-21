import {
  bundledPlugins,
  createFacetRegistry,
  defineFacet,
  definePlugin,
} from '@kamiazya/whiteboard-facet-engine'
import {
  readFacets,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { DocumentKindMismatchError, FacetWriteRejectedError } from './errors.js'
import { createFacetSetTool, facetSetInputSchema } from './facet-set.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore) {
  return { documentStore, blobStore: {} as never, documentIndex: documentStore.documentIndex }
}

describe('wb_facet_set tool', () => {
  test('sets a facet on a canvas with no prior snapshot', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(documentStore))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })

    expect(result).toEqual({
      documentId: DOCUMENT_ID,
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })
  })

  test('persists the facet so a later load reflects it', async () => {
    const store = new FakeDocumentStore()
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })

    const loaded = await store.loadSnapshot({
      docRef: { kind: 'document', documentId: DOCUMENT_ID },
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
      documentId: DOCUMENT_ID,
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      facets: { 'example.priority/v1': { level: 'high' } },
    })

    expect(result.facets).toEqual({
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
      documentId: DOCUMENT_ID,
      facets: { 'example.kanban/v1': { status: 'todo' } },
    })
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      facets: { 'example.kanban/v1': { status: 'done' } },
    })

    expect(result.facets).toEqual({ 'example.kanban/v1': { status: 'done' } })
  })

  test('throws WorkspaceDocumentNotFoundError when workspaceId does not actually own documentId', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(documentStore))

    await expect(
      tool.execute({
        workspaceId: 'ws-other',
        documentId: DOCUMENT_ID,
        facets: { 'example.kanban/v1': { status: 'todo' } },
      }),
    ).rejects.toThrow(WorkspaceDocumentNotFoundError)
  })

  test('rejects a facet key outside the {namespace}.{name}/v{n} pattern', () => {
    expect(() =>
      facetSetInputSchema.parse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
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
        documentId: DOCUMENT_ID,
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
        documentId: DOCUMENT_ID,
        facets: { 'example.sample/v1': { status: 'open' } },
      }),
    ).rejects.toThrow(DocumentKindMismatchError)

    const snap = await store.loadSnapshot({ docRef: { kind: 'document', documentId: DOCUMENT_ID } })
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
      documentId: DOCUMENT_ID,
      facets: { 'example.sample/v1': { status: 'open' } },
    })

    expect(result.facets).toEqual({ 'example.sample/v1': { status: 'open' } })
  })
})

describe('registered-facet validation (ADR-0013 decision 6)', () => {
  const documentTicket = definePlugin({
    id: 'ticket',
    facets: [
      defineFacet({
        name: 'sample',
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
      documentId: DOCUMENT_ID,
      facets: { 'ticket.sample/v0': { status: 'open' } },
    })
    expect(result.facets).toEqual({ 'ticket.sample/v0': { status: 'open' } })
  })

  test('rejects a registered facet with an invalid payload, storing nothing', async () => {
    const tool = await setupWith()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        facets: { 'ticket.sample/v0': { status: 'nope' } },
      }),
    ).rejects.toThrow(FacetWriteRejectedError)
  })

  test('rejects a write to a registered facet under a non-current version key', async () => {
    const tool = await setupWith()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        facets: { 'ticket.sample/v3': { status: 'open' } },
      }),
    ).rejects.toThrow(/ticket\.sample\/v0/)
  })

  test("rejects a canvas-target facet on a document (targets are the definition's to declare)", async () => {
    const tool = await setupWith()
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        facets: { 'visual.edges/v0': { routing: 'curved' } },
      }),
    ).rejects.toThrow(/canvas/)
  })

  test('still passes an unregistered facet through unvalidated', async () => {
    const tool = await setupWith()
    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      facets: { 'someone.else/v9': { anything: ['goes'] } },
    })
    expect(result.facets).toEqual({ 'someone.else/v9': { anything: ['goes'] } })
  })

  test('the bundled registry is the default when deps carry none', async () => {
    const documentStore = new FakeDocumentStore()
    await registerDocumentInWorkspace(documentStore, WORKSPACE_ID, DOCUMENT_ID)
    const tool = createFacetSetTool(makeDeps(documentStore))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        facets: { 'visual.edges/v0': { routing: 'spiral' } },
      }),
    ).rejects.toThrow(FacetWriteRejectedError)
  })
})
