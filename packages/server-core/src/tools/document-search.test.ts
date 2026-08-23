import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { createServer } from '../create-server.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSearchTool, documentSearchOutputSchema } from './document-search.js'
import { createDocumentSetTool } from './document-set.js'

const WS = 'ws-1'

function makeDeps() {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    documentTeardown: unusedDocumentTeardown(),
  }
}

async function seed(deps: ReturnType<typeof makeDeps>) {
  const create = (path: string, kind: 'markdown' | 'spatial', name?: string) =>
    wbDocumentCreate(deps, {
      workspaceId: WS,
      path,
      kind,
      createWorkspace: true,
      ...(name === undefined ? {} : { name }),
    })
  const set = createDocumentSetTool(deps)
  const writeBody = (documentId: string, frontmatter: string, body: string) =>
    set.execute({ workspaceId: WS, documentId, markdown: `---\n${frontmatter}\n---\n${body}` })
  return { create, writeBody, edit: createCanvasEditTool(deps) }
}

describe('wb_document_search', () => {
  it('ranks a Japanese body match first, with a snippet, and skips unrelated documents', async () => {
    const deps = makeDeps()
    const { create, writeBody } = await seed(deps)
    const hit = await create('plan', 'markdown', 'Release plan')
    const miss = await create('other', 'markdown')
    await writeBody(hit.documentId, 'type: note', 'QA完了後に検索基盤の日程を確定する。')
    await writeBody(miss.documentId, 'type: note', 'まったく関係のない話。')

    const tool = createDocumentSearchTool(deps)
    const out = documentSearchOutputSchema.parse(
      await tool.execute({ workspaceId: WS, query: '検索基盤' }),
    )
    expect(out.results.map((r) => r.documentId)).toEqual([hit.documentId])
    expect(out.results[0]).toMatchObject({ path: 'plan', name: 'Release plan', kind: 'markdown' })
    expect(out.results[0]?.contexts[0]).toContain('検索基盤')
  })

  it('finds text living on a canvas: text nodes, group labels, and edge labels', async () => {
    const deps = makeDeps()
    const { create, edit } = await seed(deps)
    const board = await create('board', 'spatial', 'Q3 board')
    await edit.execute({
      workspaceId: WS,
      documentId: board.documentId,
      ops: [
        { op: 'node.add', node: { id: 'n1', type: 'text', text: 'websocket の再接続を設計する' } },
        { op: 'node.add', node: { id: 'n2', type: 'group', label: 'インフラ構成' } },
        { op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } },
        { op: 'node.add', node: { id: 'b', type: 'text', text: 'B' } },
        {
          op: 'edge.add',
          edge: { id: 'e1', fromNode: 'a', toNode: 'b', label: 'depends on redis' },
        },
      ],
    })
    const tool = createDocumentSearchTool(deps)
    for (const query of ['再接続', 'インフラ', 'redis']) {
      const out = await tool.execute({ workspaceId: WS, query })
      expect(
        out.results.map((r) => r.documentId),
        query,
      ).toEqual([board.documentId])
    }
  })

  it('filters by kind and by tags', async () => {
    const deps = makeDeps()
    const { create, writeBody, edit } = await seed(deps)
    const tagged = await create('tagged', 'markdown')
    const untagged = await create('untagged', 'markdown')
    const board = await create('board', 'spatial')
    await writeBody(tagged.documentId, 'type: note\ntags:\n  - release', '共通の検索語を含む本文')
    await writeBody(untagged.documentId, 'type: note', '共通の検索語を含む本文')
    await edit.execute({
      workspaceId: WS,
      documentId: board.documentId,
      ops: [{ op: 'node.add', node: { id: 'n', type: 'text', text: '共通の検索語を含む本文' } }],
    })

    const tool = createDocumentSearchTool(deps)
    const all = await tool.execute({ workspaceId: WS, query: '検索語' })
    expect(all.results).toHaveLength(3)
    const markdownOnly = await tool.execute({ workspaceId: WS, query: '検索語', kind: 'markdown' })
    expect(markdownOnly.results.map((r) => r.documentId).sort()).toEqual(
      [tagged.documentId, untagged.documentId].sort(),
    )
    const taggedOnly = await tool.execute({ workspaceId: WS, query: '検索語', tags: ['release'] })
    expect(taggedOnly.results.map((r) => r.documentId)).toEqual([tagged.documentId])
  })

  it('serves the same shape over GET /search and answers 404 for an unknown workspace', async () => {
    const deps = makeDeps()
    const { create, writeBody } = await seed(deps)
    const doc = await create('plan', 'markdown')
    await writeBody(doc.documentId, 'type: note', 'searchable body text')

    const app = createServer(deps).app
    const res = await app.request(`/api/v1/workspaces/${WS}/search?q=searchable`)
    expect(res.status).toBe(200)
    const out = documentSearchOutputSchema.parse(await res.json())
    expect(out.results.map((r) => r.documentId)).toEqual([doc.documentId])

    expect((await app.request('/api/v1/workspaces/nope/search?q=x')).status).toBe(404)
    expect((await app.request(`/api/v1/workspaces/${WS}/search`)).status).toBe(400)
  })
})
