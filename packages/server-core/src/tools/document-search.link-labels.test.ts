import { describe, expect, it } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSearchTool, documentSearchOutputSchema } from './document-search.js'
import { createDocumentSetOperation } from './document-set.js'

const WS = 'ws-1'

describe('wb_document_search excerpts', () => {
  it('quote a [[link]] by the display name of what it points at', async () => {
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'folder/deep-learning/transformer',
      kind: 'markdown',
      name: 'Transformer',
    })
    const source = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: 'folder/gaiyo',
      kind: 'markdown',
    })
    await createDocumentSetOperation(deps).execute({
      workspaceId: WS,
      documentId: source.documentId,
      markdown: '---\ntype: note\n---\n注意機構は [[folder/deep-learning/transformer]] の核',
    })

    const out = documentSearchOutputSchema.parse(
      await createDocumentSearchTool(deps).execute({ workspaceId: WS, query: '注意機構' }),
    )
    expect(out.results[0]?.contexts).toEqual(['注意機構は Transformer の核'])
  })
})
