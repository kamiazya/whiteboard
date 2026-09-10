import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentGetTool } from './document-get.js'
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
    listWorkspaces: index.listWorkspaces.bind(index),
    resolveWorkspace: index.resolveWorkspace.bind(index),
    renameWorkspace: index.renameWorkspace.bind(index),
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
  return makeTestDeps()
}

async function createDoc(deps: ServerDeps, kind: 'spatial' | 'markdown') {
  // The workspace exists because this fixture says so, not as a side effect
  // of the first create: creating one is ADR-0019's MINT boundary, which
  // keys it by a fresh ULID and would leave the literal below naming nothing.
  // Idempotent on the in-memory double, so calling it per document is fine.
  await deps.documentIndex.createWorkspace({ workspaceId: 'ws' })
  const { documentId } = await wbDocumentCreate(deps, {
    workspaceId: 'ws',
    path: `doc-${kind}`,
    kind,
  })
  return documentId
}

describe('wb_document_get reads a document in its own format', () => {
  it('a markdown document comes back as OKF, with its frontmatter', async () => {
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'markdown')

    const [result] = (
      await createDocumentGetTool(deps).execute({ workspaceId: 'ws', documentIds: [documentId] })
    ).documents

    expect(result?.kind).toBe('markdown')
    expect(result?.content).toContain('---')
    expect(result?.frontmatter).toBeDefined()
  })

  it('a spatial document comes back as JSON Canvas, with no frontmatter', async () => {
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'spatial')

    const [result] = (
      await createDocumentGetTool(deps).execute({ workspaceId: 'ws', documentIds: [documentId] })
    ).documents

    expect(result?.kind).toBe('spatial')
    expect(JSON.parse(result?.content ?? '{}')).toMatchObject({ nodes: expect.any(Array) })
    // Frontmatter is OKF's. A JSON Canvas document has none, and inventing an
    // empty one would be the same comfortable lie the old placeholder `type`
    // told (ADR-0009 decision 3).
    expect(result?.frontmatter).toBeUndefined()
  })

  it('the caller never chooses the format', async () => {
    // The whole point of decision 4: two documents, same call, different
    // formats out — decided by what each document is.
    const deps = makeDeps()
    const md = await createDoc(deps, 'markdown')
    const sp = await createDoc(deps, 'spatial')

    const { documents } = await createDocumentGetTool(deps).execute({
      workspaceId: 'ws',
      documentIds: [md, sp],
    })

    expect(documents[0]?.kind).not.toBe(documents[1]?.kind)
  })

  it('a kindless doc falls back to the index row kind: markdown', async () => {
    // Pre-kind documents (the team's own ticketing backlog among them): the
    // Loro doc itself carries no kind, but the index row it was created
    // with still does. That row is consulted before refusing.
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'markdown')
    await saveDocumentSnapshot(deps, 'ws', documentId, new LoroDoc()) // overwrite: doc loses its kind

    const [result] = (
      await createDocumentGetTool(deps).execute({ workspaceId: 'ws', documentIds: [documentId] })
    ).documents

    expect(result?.kind).toBe('markdown')
    expect(result?.content).toContain('---')
    expect(result?.frontmatter).toBeDefined()
  })

  it('a kindless doc falls back to the index row kind: spatial', async () => {
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'spatial')
    await saveDocumentSnapshot(deps, 'ws', documentId, new LoroDoc()) // overwrite: doc loses its kind

    const [result] = (
      await createDocumentGetTool(deps).execute({ workspaceId: 'ws', documentIds: [documentId] })
    ).documents

    expect(result?.kind).toBe('spatial')
    expect(JSON.parse(result?.content ?? '{}')).toMatchObject({ nodes: expect.any(Array) })
    expect(result?.frontmatter).toBeUndefined()
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

    const { documents } = await createDocumentGetTool(deviantDeps).execute({
      workspaceId: 'ws',
      documentIds: [documentId],
    })

    expect(documents[0]?.kind).toBe('spatial')
  })

  it('a document with no kind, and no index row kind either, is refused, not guessed at', async () => {
    // Documents predating kinds. The old exporters would have answered
    // anyway — the OKF one by inventing a placeholder type — which is what
    // made the missing format invisible.
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'spatial')
    await saveDocumentSnapshot(deps, 'ws', documentId, new LoroDoc()) // overwrite: no kind
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

    const { documents, failed } = await createDocumentGetTool(deviantDeps).execute({
      workspaceId: 'ws',
      documentIds: [documentId],
    })

    // Refused rather than guessed at. It lands in `failed` instead of
    // throwing, because the batch has others to answer for — but nothing is
    // invented for it, which is what decision 3 is about.
    expect(documents).toEqual([])
    expect(failed.map((entry) => entry.documentId)).toEqual([documentId])

    // The way out has to name the spatial path. A document that predates
    // kinds is far more likely to be spatial than markdown — that was the
    // only kind then — and wb_document_set replaces content rather than
    // declaring a kind over it, so recommending it alone points the reader
    // at the one action that would destroy what they are trying to read.
    expect(failed[0]?.reason).toMatch(/wb_canvas_edit/)
  })

  it('reads many documents in one call, each in its own format', async () => {
    // Axis B: the cost of reading N documents was N calls, because the tool
    // took one `documentId`. The order out follows the order in, so a
    // caller can zip the results against what it asked for without
    // matching on ids.
    const deps = makeDeps()
    const md = await createDoc(deps, 'markdown')
    const sp = await createDoc(deps, 'spatial')

    const result = await createDocumentGetTool(deps).execute({
      workspaceId: 'ws',
      documentIds: [md, sp],
    })

    expect(result.documents.map((entry) => entry.documentId)).toEqual([md, sp])
    expect(result.documents.map((entry) => entry.kind)).toEqual(['markdown', 'spatial'])
    expect(result.failed).toEqual([])
  })

  it('one unreadable document does not lose the others', async () => {
    // The whole point of asking for several at once. A hard failure would
    // make the caller binary-search for the bad id, which costs more calls
    // than the batch saved.
    const deps = makeDeps()
    const good = await createDoc(deps, 'markdown')
    const kindless = await createDoc(deps, 'spatial')
    await saveDocumentSnapshot(deps, 'ws', kindless, new LoroDoc()) // overwrite: no kind
    const deviantDeps: ServerDeps = {
      ...deps,
      documentIndex: withResolveOverride(deps.documentIndex, async (input) => {
        const entry = await deps.documentIndex.resolveDocumentById(input)
        if (entry === null) return entry
        if (entry.documentId !== kindless) return entry
        const { kind: _dropped, ...rest } = entry
        return rest
      }),
    }

    const result = await createDocumentGetTool(deviantDeps).execute({
      workspaceId: 'ws',
      documentIds: [good, kindless],
    })

    expect(result.documents.map((entry) => entry.documentId)).toEqual([good])
    expect(result.failed.map((entry) => entry.documentId)).toEqual([kindless])
    // The reason has to be the one the single-document path gives, or a
    // caller reading it learns less from the batch than from N calls.
    expect(result.failed[0]?.reason).toMatch(/wb_canvas_edit/)
  })

  it('a kindless doc whose index row resolves to null (wrong workspace) is still refused', async () => {
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'spatial')
    await saveDocumentSnapshot(deps, 'ws', documentId, new LoroDoc()) // overwrite: no kind
    const deviantDeps: ServerDeps = {
      ...deps,
      // simulates the wrong-workspace / not-found case
      documentIndex: withResolveOverride(deps.documentIndex, async () => null),
      documentTeardown: unusedDocumentTeardown(),
      documentWritten: ignoredDocumentWrites(),
    }

    const { documents, failed } = await createDocumentGetTool(deviantDeps).execute({
      workspaceId: 'ws',
      documentIds: [documentId],
    })

    expect(documents).toEqual([])
    expect(failed.map((entry) => entry.documentId)).toEqual([documentId])
  })

  it('a store that will not answer fails the whole call, not one document', async () => {
    // The line the partial-failure design draws. Reporting an outage as N
    // document-shaped failures would let a caller read "18 of 20" as a fact
    // about those two documents.
    const deps = makeDeps()
    const documentId = await createDoc(deps, 'markdown')
    const brokenDeps: ServerDeps = {
      ...deps,
      documentStore: {
        ...deps.documentStore,
        loadSnapshot: async () => {
          throw new Error('the store is down')
        },
      },
    }

    await expect(
      createDocumentGetTool(brokenDeps).execute({ workspaceId: 'ws', documentIds: [documentId] }),
    ).rejects.toThrow(/the store is down/)
  })
})
