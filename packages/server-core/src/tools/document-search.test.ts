import { describe, expect, it } from 'vitest'
import { createServer } from '../create-server.js'
import type { ServerDeps } from '../server-deps.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { wbDocumentCreate } from './document-crud.js'
import {
  createDocumentSearchTool,
  documentSearchOutputSchema,
  SearchNeedsQueryOrFilterError,
} from './document-search.js'
import { createDocumentSetTool } from './document-set.js'
import { createFacetSetTool } from './facet-set.js'

const WS = 'ws-1'

function makeDeps(): ServerDeps {
  return makeTestDeps()
}

async function seed(deps: ReturnType<typeof makeDeps>) {
  // The workspace exists because this fixture says so, not as a side effect
  // of the first create: creating one is ADR-0019's MINT boundary, which
  // keys it by a fresh ULID and would leave the literal below naming nothing.
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  const create = (path: string, kind: 'markdown' | 'spatial', name?: string) =>
    wbDocumentCreate(deps, {
      workspaceId: WS,
      path,
      kind,
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
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { id: 'n1', type: 'text', text: 'websocket の再接続を設計する' } },
        { op: 'node.add', node: { id: 'n2', type: 'group', label: 'インフラ構成' } },
        { op: 'node.add', node: { id: 'a', type: 'text', text: 'A' } },
        { op: 'node.add', node: { id: 'b', type: 'text', text: 'B' } },
        {
          op: 'edge.add',
          edge: {
            id: 'e1',
            from: { node: 'a' },
            to: { node: 'b' },
            label: 'depends on redis',
          },
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
      mode: 'apply',
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

  // "Which documents carry this tag" is a question a tag is FOR, and a tag
  // is not searchable text: a query that names it matches nothing, so the
  // filter has to be able to stand alone. Found by the tool-surface eval
  // lane (ADR-0031 §3), where a model asked to count tagged documents
  // searched for the tag, was answered nothing, and believed it.
  it('answers every document carrying the tag when no query is given', async () => {
    const deps = makeDeps()
    const { create, writeBody } = await seed(deps)
    const a = await create('a', 'markdown')
    const b = await create('b', 'markdown')
    const c = await create('c', 'markdown')
    await writeBody(a.documentId, 'type: note\ntags:\n  - process', 'one')
    await writeBody(b.documentId, 'type: note\ntags:\n  - process\n  - people', 'two')
    await writeBody(c.documentId, 'type: note\ntags:\n  - retro', 'three')

    const tool = createDocumentSearchTool(deps)
    const out = documentSearchOutputSchema.parse(
      await tool.execute({ workspaceId: WS, tags: ['process'] }),
    )
    expect(out.results.map((r) => r.path)).toEqual(['a', 'b'])
    // No keyword ranked these, and the shape says so the way a semantic-only
    // hit does: no lexicalRank, and the opening of the text for context.
    expect(out.results[0]?.lexicalRank).toBeUndefined()
    expect(out.results[0]?.contexts[0]).toContain('one')
    // A search with the tag as its query still finds nothing — the tag is
    // frontmatter, not body — which is why the filter stands alone.
    const byWord = await tool.execute({ workspaceId: WS, query: 'process' })
    expect(byWord.results).toEqual([])
  })

  // ADR-0040 decision 3: a spatial document matches a tag filter when its
  // board, any ONE of its nodes or any ONE of its edges carries every listed
  // tag, and the answer names the matching nodes and edges as excerpts.
  it('finds a board by a tag one of its nodes carries, and names the node as the excerpt', async () => {
    const deps = makeDeps()
    const { create, edit } = await seed(deps)
    const board = await create('fleet', 'spatial', 'Fleet')
    await edit.execute({
      workspaceId: WS,
      documentId: board.documentId,
      mode: 'apply',
      ops: [
        { op: 'node.add', node: { id: 'redis', type: 'text', text: 'Redis cache' } },
        { op: 'node.add', node: { id: 'pg', type: 'text', text: 'Postgres' } },
        { op: 'edge.add', edge: { id: 'e1', from: { node: 'pg' }, to: { node: 'redis' } } },
      ],
    })
    const facets = createFacetSetTool(deps)
    await facets.execute({
      workspaceId: WS,
      documentIds: [board.documentId],
      nodeId: 'redis',
      tags: { add: ['health:failing', 'tier:data'] },
    })
    await facets.execute({
      workspaceId: WS,
      documentIds: [board.documentId],
      nodeId: 'pg',
      tags: { add: ['tier:data'] },
    })
    await facets.execute({
      workspaceId: WS,
      documentIds: [board.documentId],
      edgeId: 'e1',
      tags: { add: ['link:failing'] },
    })
    const tool = createDocumentSearchTool(deps)

    const failing = documentSearchOutputSchema.parse(
      await tool.execute({ workspaceId: WS, tags: ['health:failing'] }),
    )
    expect(failing.results.map((r) => r.documentId)).toEqual([board.documentId])
    expect(failing.results[0]?.contexts).toEqual(['Redis cache'])

    // Every listed tag on ONE bearer: `tier:data` and `health:failing` are
    // both on redis, so the board matches; `tier:data` and `link:failing`
    // are on a node and an edge, so it does not.
    const both = await tool.execute({ workspaceId: WS, tags: ['tier:data', 'health:failing'] })
    expect(both.results.map((r) => r.documentId)).toEqual([board.documentId])
    const split = await tool.execute({ workspaceId: WS, tags: ['tier:data', 'link:failing'] })
    expect(split.results).toEqual([])

    // An edge is named by its label, or by its two ends when it has none.
    const link = await tool.execute({ workspaceId: WS, tags: ['link:failing'] })
    expect(link.results[0]?.contexts).toEqual(['Postgres → Redis cache'])

    // Two nodes carry `tier:data`: both are named. Order is the store's,
    // which promises membership and not sequence.
    const tier = await tool.execute({ workspaceId: WS, tags: ['tier:data'] })
    expect([...(tier.results[0]?.contexts ?? [])].sort()).toEqual(['Postgres', 'Redis cache'])
  })

  it('finds a board by its own tags, with a query as well as without', async () => {
    const deps = makeDeps()
    const { create, edit } = await seed(deps)
    const board = await create('plan', 'spatial', 'Plan')
    await edit.execute({
      workspaceId: WS,
      documentId: board.documentId,
      mode: 'apply',
      ops: [{ op: 'node.add', node: { id: 'n', type: 'text', text: 'design the sync protocol' } }],
    })
    await createFacetSetTool(deps).execute({
      workspaceId: WS,
      documentIds: [board.documentId],
      tags: { add: ['phase:design'] },
    })
    const tool = createDocumentSearchTool(deps)
    const filtered = await tool.execute({ workspaceId: WS, tags: ['phase:design'] })
    expect(filtered.results.map((r) => r.documentId)).toEqual([board.documentId])
    const withQuery = await tool.execute({ workspaceId: WS, query: 'sync', tags: ['phase:design'] })
    expect(withQuery.results.map((r) => r.documentId)).toEqual([board.documentId])
    const wrongTag = await tool.execute({ workspaceId: WS, query: 'sync', tags: ['phase:build'] })
    expect(wrongTag.results).toEqual([])
  })

  it('refuses a call with neither a query nor a filter, rather than listing everything', async () => {
    const deps = makeDeps()
    await seed(deps)
    await expect(createDocumentSearchTool(deps).execute({ workspaceId: WS })).rejects.toThrow(
      SearchNeedsQueryOrFilterError,
    )
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
