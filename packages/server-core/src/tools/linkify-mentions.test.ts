import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { createServer } from '../create-server.js'
import { ignoredDocumentWrites } from '../test-utils/ignored-document-writes.js'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { unusedDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { backlinksOutputSchema } from './backlinks.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentGetTool } from './document-get.js'
import { createDocumentSetTool } from './document-set.js'
import { linkifyMentionsOutputSchema } from './linkify-mentions.js'

const WS = 'ws-1'

function makeDeps() {
  return {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
    documentTeardown: unusedDocumentTeardown(),
    documentWritten: ignoredDocumentWrites(),
  }
}

function harness(deps: ReturnType<typeof makeDeps>) {
  const app = createServer(deps).app
  const create = (path: string, kind: 'markdown' | 'spatial', name?: string) =>
    wbDocumentCreate(deps, {
      workspaceId: WS,
      path,
      kind,
      createWorkspace: true,
      ...(name === undefined ? {} : { name }),
    })
  const set = createDocumentSetTool(deps)
  const writeBody = (documentId: string, body: string) =>
    set.execute({ workspaceId: WS, documentId, markdown: `---\ntype: note\n---\n${body}` })
  const readBody = async (documentId: string) => {
    const out = await createDocumentGetTool(deps).execute({ workspaceId: WS, documentId })
    return out.content.split('---\n').slice(2).join('---\n')
  }
  const linkify = async (sourceId: string, targetDocumentId: string) => {
    const res = await app.request(
      `/api/v1/workspaces/${WS}/documents/${sourceId}/linkify-mentions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetDocumentId }),
      },
    )
    return {
      status: res.status,
      body:
        res.status === 200 ? linkifyMentionsOutputSchema.parse(await res.json()) : await res.json(),
    }
  }
  const backlinksOf = async (documentId: string) => {
    const res = await app.request(`/api/v1/workspaces/${WS}/documents/${documentId}/backlinks`)
    return backlinksOutputSchema.parse(await res.json())
  }
  return { app, create, writeBody, readBody, linkify, backlinksOf }
}

describe('POST /linkify-mentions', () => {
  it('wraps every prose occurrence, skips existing references, and the mention disappears', async () => {
    const deps = makeDeps()
    const h = harness(deps)
    const target = await h.create('target', 'markdown', '設計メモ')
    const src = await h.create('src', 'markdown', '日報')
    await h.writeBody(
      src.documentId,
      '会議で設計メモの前提が変わった。既存の [[設計メモ]] は触らない。末尾にも設計メモ。',
    )

    const out = await h.linkify(src.documentId, target.documentId)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ linked: 2 })
    expect(await h.readBody(src.documentId)).toBe(
      '会議で[[設計メモ]]の前提が変わった。既存の [[設計メモ]] は触らない。末尾にも[[設計メモ]]。',
    )

    // Detection and linkify share one span rule: nothing left to mention.
    const after = await h.backlinksOf(target.documentId)
    expect(after.unlinkedMentions).toEqual([])
    expect(after.backlinks.map((b) => b.path)).toEqual(['src'])

    // Idempotent: nothing found, nothing written.
    expect((await h.linkify(src.documentId, target.documentId)).body).toEqual({ linked: 0 })
  })

  it('an ambiguous name links by id with the name as alias', async () => {
    const deps = makeDeps()
    const h = harness(deps)
    const target = await h.create('target', 'markdown', 'Dup')
    await h.create('rival', 'markdown', 'Dup')
    const src = await h.create('src', 'markdown')
    await h.writeBody(src.documentId, 'about Dup here')
    expect((await h.linkify(src.documentId, target.documentId)).body).toEqual({ linked: 1 })
    expect(await h.readBody(src.documentId)).toBe(`about [[${target.documentId}|Dup]] here`)
  })

  it('rewrites canvas text nodes but never labels', async () => {
    const deps = makeDeps()
    const h = harness(deps)
    const target = await h.create('target', 'markdown', 'Redis')
    const board = await h.create('board', 'spatial')
    const edit = createCanvasEditTool(deps)
    await edit.execute({
      workspaceId: WS,
      documentId: board.documentId,
      ops: [
        { op: 'node.add', node: { id: 'a', type: 'text', text: 'we depend on Redis heavily' } },
        { op: 'node.add', node: { id: 'b', type: 'text', text: 'B' } },
        { op: 'edge.add', edge: { id: 'e', fromNode: 'a', toNode: 'b', label: 'Redis link' } },
      ],
    })
    expect((await h.linkify(board.documentId, target.documentId)).body).toEqual({ linked: 1 })
    const canvas = await createDocumentGetTool(deps).execute({
      workspaceId: WS,
      documentId: board.documentId,
    })
    const parsed = JSON.parse(canvas.content)
    expect(parsed.nodes.find((n: { id: string }) => n.id === 'a').text).toBe(
      'we depend on [[Redis]] heavily',
    )
    // A [[link]] in a label would render as literal brackets, so labels are
    // mention-detected but never rewritten.
    expect(parsed.edges[0].label).toBe('Redis link')
  })

  it('refuses a nameless target and unknown documents', async () => {
    const deps = makeDeps()
    const h = harness(deps)
    const nameless = await h.create('nameless', 'markdown')
    const src = await h.create('src', 'markdown')
    expect((await h.linkify(src.documentId, nameless.documentId)).status).toBe(400)
    expect((await h.linkify(src.documentId, '01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(404)
  })
})
