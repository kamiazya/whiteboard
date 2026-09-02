import { describe, expect, it } from 'vitest'
import { createServer } from '../create-server.js'
import type { ServerDeps } from '../server-deps.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { backlinksOutputSchema } from './backlinks.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { wbDocumentCreate } from './document-crud.js'
import { createDocumentSetTool } from './document-set.js'

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
  const target = await create('target', 'markdown', 'Release plan')
  const setBody = createDocumentSetTool(deps)
  // wb_document_set takes a full OKF document; wrap the body in the minimal
  // frontmatter the parser requires.
  const writeBody = (documentId: string, body: string) =>
    setBody.execute({ workspaceId: WS, documentId, markdown: `---\ntype: markdown\n---\n${body}` })
  return { create, target, writeBody }
}

async function backlinksOf(deps: ReturnType<typeof makeDeps>, documentId: string) {
  const res = await createServer(deps).app.request(
    `/api/v1/workspaces/${WS}/documents/${documentId}/backlinks`,
  )
  expect(res.status).toBe(200)
  return backlinksOutputSchema.parse(await res.json())
}

describe('GET /backlinks', () => {
  it('a document NAMED exactly its own path still receives backlinks', async () => {
    // A path entry and a name entry both claim the alias — with ONE id, so
    // it is unique, and the reader navigates it. The resolver used to count
    // claims instead of owners and dropped the backlink the preview renders
    // live. Found by the command-sequence property (seed -223444648).
    const deps = makeDeps()
    const { create, writeBody } = await seed(deps)
    const twice = await create('beta/leaf', 'markdown', 'beta/leaf')
    const source = await create('notes', 'markdown')
    await writeBody(source.documentId, 'mention [[beta/leaf]] here.')

    const out = await backlinksOf(deps, twice.documentId)
    expect(out.backlinks.map((b) => b.documentId)).toEqual([source.documentId])
  })

  it('reports an id wikilink, with a context snippet', async () => {
    const deps = makeDeps()
    const { create, target, writeBody } = await seed(deps)
    const src = await create('notes', 'markdown', 'Sprint notes')
    await writeBody(src.documentId, `QA完了後に [[${target.documentId}]] の日程を確定する。`)

    const out = await backlinksOf(deps, target.documentId)
    expect(out.backlinks).toHaveLength(1)
    expect(out.backlinks[0]).toMatchObject({
      documentId: src.documentId,
      path: 'notes',
      name: 'Sprint notes',
      kind: 'markdown',
    })
    expect(out.backlinks[0]?.contexts[0]).toContain('日程を確定')
  })

  it('reports unique-name and path links, and refuses an ambiguous name', async () => {
    const deps = makeDeps()
    const { create, target, writeBody } = await seed(deps)
    const src = await create('a', 'markdown')
    // Both bracket spellings the reader resolves: display name and path.
    await writeBody(src.documentId, 'see [[Release plan]] and [[target]]')
    const one = await backlinksOf(deps, target.documentId)
    expect(one.backlinks).toHaveLength(1)
    expect(one.backlinks[0]?.contexts).toHaveLength(2)

    // A second document takes the same name: the reader stops resolving that
    // alias, so the name-link disappears as a backlink — while the path link,
    // still unambiguous, survives.
    await create('b', 'markdown', 'Release plan')
    const after = await backlinksOf(deps, target.documentId)
    expect(after.backlinks).toHaveLength(1)
    expect(after.backlinks[0]?.contexts).toHaveLength(1)
    expect(after.backlinks[0]?.contexts[0]).toContain('[[target]]')
  })

  it('reports spatial references: embed node, file-node path ref, text-node wikilink', async () => {
    const deps = makeDeps()
    const { create, target } = await seed(deps)
    const canvas = await create('board', 'spatial', 'Q3 roadmap')
    const edit = createCanvasEditTool(deps)
    await edit.execute({
      workspaceId: WS,
      documentId: canvas.documentId,
      ops: [
        {
          op: 'node.add',
          node: {
            id: 'n-embed',
            type: 'file',
            file: 'embed-placeholder',
            'x-whiteboard': { kind: 'embed', documentId: target.documentId },
          },
        },
        { op: 'node.add', node: { id: 'n-file', type: 'file', file: 'target' } },
        {
          op: 'node.add',
          node: { id: 'n-text', type: 'text', text: `詳細は [[${target.documentId}]]` },
        },
      ],
    })

    const out = await backlinksOf(deps, target.documentId)
    expect(out.backlinks).toHaveLength(1)
    expect(out.backlinks[0]?.documentId).toBe(canvas.documentId)
    expect(out.backlinks[0]?.contexts).toHaveLength(3)
  })

  it('a later rename onto a linked name kills the link, even one that pointed at its own author', async () => {
    // Pinned from the shrunk counterexample the reference-semantics property
    // found (against a deliberately mutated last-wins resolver): a document
    // NAMED Plan writes [[Plan]] — unique, so it resolves to itself and the
    // self-skip yields no backlink — then a SECOND document takes the name
    // Plan. Resolution must collapse to ambiguity for everyone, not fall
    // back to whichever entry happened to be written last.
    const deps = makeDeps()
    const { create, writeBody } = await seed(deps)
    const other = await create('gamma', 'spatial', 'Note')
    const author = await create('alpha', 'markdown', 'Plan')
    await writeBody(author.documentId, 'see [[Plan]]')
    await deps.documentIndex.setDocumentName({
      workspaceId: WS,
      documentId: other.documentId,
      name: 'Plan',
    })
    expect((await backlinksOf(deps, author.documentId)).backlinks).toHaveLength(0)
    expect((await backlinksOf(deps, other.documentId)).backlinks).toHaveLength(0)
  })

  it('reports unlinked mentions: the name in prose, never inside a reference', async () => {
    const deps = makeDeps()
    const { create, writeBody } = await seed(deps)
    // seed() created the target named 'Release plan' at path 'target'.
    const [plain, linked, aliasOnly] = [
      await create('plain-mention', 'markdown', 'Plain'),
      await create('linked-too', 'markdown', 'Linked'),
      await create('alias-only', 'markdown', 'Alias'),
    ]
    const targetId = (await deps.documentIndex.resolveDocument({ workspaceId: WS, path: 'target' }))
      ?.documentId
    if (targetId === undefined) throw new Error('target missing')
    await writeBody(plain.documentId, '会議で Release plan の前提が変わった。')
    // A document that LINKS and also mentions in prose sits in both lists.
    await writeBody(
      linked.documentId,
      'see [[Release plan]] — and later, Release plan again in prose.',
    )
    // The name only as an alias inside a reference: no mention.
    await writeBody(aliasOnly.documentId, `see [[${targetId}|Release plan]]`)

    const out = await backlinksOf(deps, targetId)
    expect(out.backlinks.map((b) => b.path).sort()).toEqual(['alias-only', 'linked-too'])
    expect(out.unlinkedMentions.map((m) => m.path).sort()).toEqual(['linked-too', 'plain-mention'])
    expect(out.unlinkedMentions.find((m) => m.path === 'plain-mention')?.contexts[0]).toContain(
      '前提が変わった',
    )
  })

  it('an unnamed document accrues no mentions — a path is an address, not prose', async () => {
    const deps = makeDeps()
    const { create, writeBody } = await seed(deps)
    const unnamed = await create('nameless', 'markdown')
    const src = await create('src', 'markdown')
    await writeBody(src.documentId, 'the word nameless appears here in prose')
    const out = await backlinksOf(deps, unnamed.documentId)
    expect(out.unlinkedMentions).toEqual([])
  })

  it('excludes self-references and answers 404 for an unknown document', async () => {
    const deps = makeDeps()
    const { target, writeBody } = await seed(deps)
    await writeBody(target.documentId, `self: [[${target.documentId}]]`)
    expect((await backlinksOf(deps, target.documentId)).backlinks).toHaveLength(0)

    const res = await createServer(deps).app.request(
      `/api/v1/workspaces/${WS}/documents/01ARZ3NDEKTSV4RRFFQ69G5FAV/backlinks`,
    )
    expect(res.status).toBe(404)

    // An unknown WORKSPACE is the same answer — the index's own error must
    // translate to 404 rather than escaping as a 500.
    const noWs = await createServer(deps).app.request(
      '/api/v1/workspaces/nope/documents/01ARZ3NDEKTSV4RRFFQ69G5FAV/backlinks',
    )
    expect(noWs.status).toBe(404)
  })
})
