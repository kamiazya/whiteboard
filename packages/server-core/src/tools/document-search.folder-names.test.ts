import type { DocumentFolders } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSearchTool, documentSearchOutputSchema } from './document-search.js'

const WS = 'ws-1'

describe('wb_document_search folder names', () => {
  it('finds a document by the display name of its folder, below a document that says the word', async () => {
    const folders: DocumentFolders = {
      listFolderNames: async () => [{ path: 'quipe-ops', name: 'Operations Team' }],
      setFolderName: async () => {},
    }
    const documentIndex = Object.assign(new InMemoryDocumentIndex(), folders)
    await documentIndex.createWorkspace({ workspaceId: WS })
    const deps = makeTestDeps({ documentIndex })
    const inFolder = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'quipe-ops/untitled-8',
      kind: 'markdown',
    })
    const named = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'reports/review',
      kind: 'markdown',
      name: 'Operations review',
    })
    await wbDocumentCreate(deps, { workspaceId: WS, path: 'misc/other', kind: 'markdown' })

    const out = documentSearchOutputSchema.parse(
      await createDocumentSearchTool(deps).execute({ workspaceId: WS, query: 'operations' }),
    )
    expect(out.results.map((hit) => hit.documentId)).toEqual([
      named.documentId,
      inFolder.documentId,
    ])
  })
})
