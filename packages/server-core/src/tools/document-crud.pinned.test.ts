import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreate, wbDocumentList } from './document-crud.js'

const WS = 'ws-1'

async function makeDeps() {
  const deps = makeTestDeps({ documentTeardown: inMemoryDocumentTeardown() })
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  return deps
}

describe('wbDocumentList pinned', () => {
  it('says which documents the workspace pins, and that the rest are not', async () => {
    const deps = await makeDeps()
    const index = deps.documentIndex as InMemoryDocumentIndex
    const a = await wbDocumentCreate(deps, { workspaceId: WS, path: 'a', kind: 'spatial' })
    await wbDocumentCreate(deps, { workspaceId: WS, path: 'b', kind: 'markdown' })
    await index.setDocumentPinned({ workspaceId: WS, documentId: a.documentId, pinned: true })

    const { documents } = await wbDocumentList(deps, { workspaceId: WS })

    expect(documents.map(({ path, pinned }) => ({ path, pinned }))).toEqual([
      { path: 'a', pinned: true },
      { path: 'b', pinned: false },
    ])
  })

  it('stops saying a document is pinned once it is unpinned', async () => {
    const deps = await makeDeps()
    const index = deps.documentIndex as InMemoryDocumentIndex
    const a = await wbDocumentCreate(deps, { workspaceId: WS, path: 'a', kind: 'spatial' })
    await index.setDocumentPinned({ workspaceId: WS, documentId: a.documentId, pinned: true })
    await index.setDocumentPinned({ workspaceId: WS, documentId: a.documentId, pinned: false })

    const { documents } = await wbDocumentList(deps, { workspaceId: WS })

    expect(documents.map((entry) => entry.pinned)).toEqual([false])
  })

  // An index with no pinned list cannot answer "not pinned": that would claim
  // a fact it does not hold, so the field is absent instead.
  it('omits the field when the index keeps no pins, rather than claiming false', async () => {
    const inner = new InMemoryDocumentIndex()
    await inner.createWorkspace({ workspaceId: WS })
    inner.seed({
      workspaceId: WS,
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'a',
      kind: 'spatial',
    })
    const withoutPins: DocumentIndex = {
      listDocuments: (input) => inner.listDocuments(input),
    } as DocumentIndex
    const deps = makeTestDeps({ documentIndex: withoutPins })

    const { documents } = await wbDocumentList(deps, { workspaceId: WS })

    expect(documents).toHaveLength(1)
    expect(documents[0]).not.toHaveProperty('pinned')
  })
})
