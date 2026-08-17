import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { wbCanvasCreate } from './canvas-crud.js'
import { createDocumentGetTool, DocumentKindUnknownError } from './document-get.js'
import { saveDocumentSnapshot } from './document-io.js'

/**
 * Wraps a real DocumentIndex, replacing only resolveDocumentById's answer.
 * createDocument requires `kind` as input, so this is the only way to mint
 * an index row whose fallback answer disagrees with (or omits) the kind a
 * document was actually created with.
 */
function withResolveOverride(
  index: DocumentIndex,
  resolveDocumentById: DocumentIndex['resolveDocumentById'],
): DocumentIndex {
  return {
    createWorkspace: index.createWorkspace.bind(index),
    createDocument: index.createDocument.bind(index),
    resolveDocument: index.resolveDocument.bind(index),
    resolveDocumentById,
    setDocumentName: index.setDocumentName.bind(index),
    listDocuments: index.listDocuments.bind(index),
    moveDocument: index.moveDocument.bind(index),
    deleteDocument: index.deleteDocument.bind(index),
  }
}

function makeDeps(): ServerDeps {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  }
}

async function createDoc(deps: ServerDeps, kind: 'spatial' | 'markdown') {
  const { documentId } = await wbCanvasCreate(deps, {
    workspaceId: 'ws',
    path: `doc-${kind}`,
    kind,
    createWorkspace: true,
  })
  return documentId
}

describe('wb_document_get reads a document in its own format', () => {
  it('a markdown document comes back as OKF, with its frontmatter', async () => {
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'markdown')

    const result = await createDocumentGetTool(deps).execute({ workspaceId: 'ws', documentId })

    expect(result.kind).toBe('markdown')
    expect(result.content).toContain('---')
    expect(result.frontmatter).toBeDefined()
  })

  it('a spatial document comes back as JSON Canvas, with no frontmatter', async () => {
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'spatial')

    const result = await createDocumentGetTool(deps).execute({ workspaceId: 'ws', documentId })

    expect(result.kind).toBe('spatial')
    expect(JSON.parse(result.content)).toMatchObject({ nodes: expect.any(Array) })
    // Frontmatter is OKF's. A JSON Canvas document has none, and inventing an
    // empty one would be the same comfortable lie the old placeholder `type`
    // told (ADR-0009 decision 3).
    expect(result.frontmatter).toBeUndefined()
  })

  it('the caller never chooses the format', async () => {
    // The whole point of decision 4: two documents, same call, different
    // formats out — decided by what each document is.
    const deps = makeDeps()
    const md = await createDoc(deps, 'markdown')
    const sp = await createDoc(deps, 'spatial')
    const tool = createDocumentGetTool(deps)

    const a = await tool.execute({ workspaceId: 'ws', documentId: md })
    const b = await tool.execute({ workspaceId: 'ws', documentId: sp })

    expect(a.kind).not.toBe(b.kind)
  })

  it('a kindless doc falls back to the index row kind: markdown', async () => {
    // Pre-kind documents (the team's own ticketing backlog among them): the
    // Loro doc itself carries no kind, but the index row it was created
    // with still does. That row is consulted before refusing.
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'markdown')
    await saveDocumentSnapshot(deps, documentId, new LoroDoc()) // overwrite: doc loses its kind

    const result = await createDocumentGetTool(deps).execute({ workspaceId: 'ws', documentId })

    expect(result.kind).toBe('markdown')
    expect(result.content).toContain('---')
    expect(result.frontmatter).toBeDefined()
  })

  it('a kindless doc falls back to the index row kind: spatial', async () => {
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'spatial')
    await saveDocumentSnapshot(deps, documentId, new LoroDoc()) // overwrite: doc loses its kind

    const result = await createDocumentGetTool(deps).execute({ workspaceId: 'ws', documentId })

    expect(result.kind).toBe('spatial')
    expect(JSON.parse(result.content)).toMatchObject({ nodes: expect.any(Array) })
    expect(result.frontmatter).toBeUndefined()
  })

  it("a document's own recorded kind wins over a disagreeing index row", async () => {
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'spatial')
    // The doc itself still records 'spatial' (untouched); only the index
    // row is made to disagree, to prove precedence rather than fallback.
    const deviantDeps: ServerDeps = {
      ...deps,
      documentIndex: withResolveOverride(deps.documentIndex, async (input) => {
        const entry = await deps.documentIndex.resolveDocumentById(input)
        return entry ? { ...entry, kind: 'markdown' } : entry
      }),
    }

    const result = await createDocumentGetTool(deviantDeps).execute({
      workspaceId: 'ws',
      documentId,
    })

    expect(result.kind).toBe('spatial')
  })

  it('a document with no kind, and no index row kind either, is refused, not guessed at', async () => {
    // Documents predating kinds. The old exporters would have answered
    // anyway — the OKF one by inventing a placeholder type — which is what
    // made the missing format invisible.
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'spatial')
    await saveDocumentSnapshot(deps, documentId, new LoroDoc()) // overwrite: no kind
    const deviantDeps: ServerDeps = {
      ...deps,
      // strips `kind` from the real index's answer
      documentIndex: withResolveOverride(deps.documentIndex, async (input) => {
        const entry = await deps.documentIndex.resolveDocumentById(input)
        if (entry === null) return entry
        const { kind: _dropped, ...rest } = entry
        return rest
      }),
    }

    await expect(
      createDocumentGetTool(deviantDeps).execute({ workspaceId: 'ws', documentId }),
    ).rejects.toThrow(DocumentKindUnknownError)

    // The way out has to name the spatial path. A document that predates
    // kinds is far more likely to be spatial than markdown — that was the
    // only kind then — and wb_document_set replaces content rather than
    // declaring a kind over it, so recommending it alone points the reader
    // at the one action that would destroy what they are trying to read.
    await expect(
      createDocumentGetTool(deviantDeps).execute({ workspaceId: 'ws', documentId }),
    ).rejects.toThrow(/wb_node_add/)
  })

  it('a kindless doc whose index row resolves to null (wrong workspace) is still refused', async () => {
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'spatial')
    await saveDocumentSnapshot(deps, documentId, new LoroDoc()) // overwrite: no kind
    const deviantDeps: ServerDeps = {
      ...deps,
      // simulates the wrong-workspace / not-found case
      documentIndex: withResolveOverride(deps.documentIndex, async () => null),
    }

    await expect(
      createDocumentGetTool(deviantDeps).execute({ workspaceId: 'ws', documentId }),
    ).rejects.toThrow(DocumentKindUnknownError)
  })
})
