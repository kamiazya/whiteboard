import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { wbCanvasCreate } from './canvas-crud.js'
import { createDocumentGetTool, DocumentKindUnknownError } from './document-get.js'
import { saveDocumentSnapshot } from './document-io.js'

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

  it('a document with no kind is refused, not guessed at', async () => {
    // Documents predating kinds. The old exporters would have answered
    // anyway — the OKF one by inventing a placeholder type — which is what
    // made the missing format invisible.
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'spatial')
    await saveDocumentSnapshot(deps, documentId, new LoroDoc()) // overwrite: no kind

    await expect(
      createDocumentGetTool(deps).execute({ workspaceId: 'ws', documentId }),
    ).rejects.toThrow(DocumentKindUnknownError)

    // The way out has to name the spatial path. A document that predates
    // kinds is far more likely to be spatial than markdown — that was the
    // only kind then — and wb_document_set replaces content rather than
    // declaring a kind over it, so recommending it alone points the reader
    // at the one action that would destroy what they are trying to read.
    await expect(
      createDocumentGetTool(deps).execute({ workspaceId: 'ws', documentId }),
    ).rejects.toThrow(/wb_node_add/)
  })
})
