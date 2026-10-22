// A batch is refused whole or written whole: a document LATER in the batch
// whose kind cannot hold the write must refuse before the first is written,
// since each document is its own Loro doc and nothing rolls a prefix back.

import { readFacets, readSpatialCanvas, writeDocumentKind } from '@kamiazya/whiteboard-loro-adapter'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { DocumentKindMismatchError } from './errors.js'
import { createFacetSetTool } from './facet-set.js'

const WORKSPACE_ID = 'ws-1'
const FIRST_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const SECOND_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'

async function storeOf(first: 'markdown' | 'spatial', second: 'markdown' | 'spatial') {
  const store = new FakeDocumentStore()
  await registerDocumentInWorkspace(store, WORKSPACE_ID, FIRST_ID)
  await registerDocumentInWorkspace(store, WORKSPACE_ID, SECOND_ID, 'second')
  await seedDoc(store, FIRST_ID, (doc) => writeDocumentKind(doc, first))
  await seedDoc(store, SECOND_ID, (doc) => writeDocumentKind(doc, second))
  const tool = createFacetSetTool(
    makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
  )
  const firstAsStored = async (): Promise<LoroDoc> => {
    const loaded = await store.loadSnapshot({
      docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: FIRST_ID },
    })
    if (loaded === null) throw new Error('nothing stored')
    const doc = new LoroDoc()
    doc.import(reassembleSnapshot(loaded.manifest, loaded.chunks))
    return doc
  }
  return { tool, firstAsStored }
}

describe('wb_facet_set refuses a kind mismatch anywhere in the batch first', () => {
  test('a spatial document later in the batch refuses facets before the first is written', async () => {
    const { tool, firstAsStored } = await storeOf('markdown', 'spatial')
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [FIRST_ID, SECOND_ID],
        facets: { 'example.kanban/v1': { status: 'todo' } },
      }),
    ).rejects.toThrow(DocumentKindMismatchError)
    expect(readFacets(await firstAsStored())).toEqual({})
  })

  test("a markdown document later in the batch refuses target: 'canvas' before the first is written", async () => {
    const { tool, firstAsStored } = await storeOf('spatial', 'markdown')
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentIds: [FIRST_ID, SECOND_ID],
        target: 'canvas',
        tags: { add: ['reviewed'] },
      }),
    ).rejects.toThrow(DocumentKindMismatchError)
    expect(readSpatialCanvas(await firstAsStored()).tags).toBeUndefined()
  })
})
