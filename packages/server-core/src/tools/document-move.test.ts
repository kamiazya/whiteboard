import { readMarkdownBody } from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { WorkspaceDocumentNotFoundError } from './document-crud.errors.js'
import { wbDocumentCreate } from './document-crud.js'
import { loadOrCreateDocument } from './document-io.js'
import { wbDocumentMove } from './document-move.js'
import { createDocumentSetTool } from './document-set.js'

const WS = 'ws-move'

async function seed(deps: ServerDeps) {
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  const create = (path: string) =>
    wbDocumentCreate(deps, { workspaceId: WS, path, kind: 'markdown' })
  const set = createDocumentSetTool(deps)
  const write = (documentId: string, body: string) =>
    set.execute({ workspaceId: WS, documentId, markdown: `---\ntype: note\n---\n${body}` })
  const bodyOf = async (documentId: string) =>
    readMarkdownBody(await loadOrCreateDocument(deps, WS, documentId as never))
  const pathOf = async (documentId: string) =>
    (await deps.documentIndex.resolveDocumentById({ workspaceId: WS, documentId }))?.path
  return { create, write, bodyOf, pathOf }
}

describe('wbDocumentMove', () => {
  it('moves the document and repoints what other documents wrote to its old path', async () => {
    const deps = makeTestDeps()
    const { create, write, bodyOf, pathOf } = await seed(deps)
    const target = await create('design/login')
    const source = await create('notes/daily')
    await write(source.documentId, 'see [[design/login]] and [[unrelated]]')

    const moved = await wbDocumentMove(deps, {
      workspaceId: WS,
      documentId: target.documentId,
      path: 'archive/login',
    })

    expect(moved).toMatchObject({
      documentId: target.documentId,
      from: 'design/login',
      path: 'archive/login',
      follow: { updatedDocumentIds: [source.documentId], failedDocumentIds: [] },
    })
    expect(await pathOf(target.documentId)).toBe('archive/login')
    expect(await bodyOf(source.documentId)).toBe('see [[archive/login]] and [[unrelated]]')
  })

  it('carries the documents below the path with it, references and all', async () => {
    const deps = makeTestDeps()
    const { create, write, bodyOf, pathOf } = await seed(deps)
    const parent = await create('design')
    const child = await create('design/login')
    const source = await create('notes/daily')
    await write(source.documentId, 'see [[design/login]]')

    await wbDocumentMove(deps, { workspaceId: WS, documentId: parent.documentId, path: 'archive' })

    expect(await pathOf(child.documentId)).toBe('archive/login')
    expect(await bodyOf(source.documentId)).toBe('see [[archive/login]]')
  })

  it('moves the document it was given when that is not the first one the listing returns', async () => {
    const deps = makeTestDeps()
    const { create, pathOf } = await seed(deps)
    const first = await create('a/first')
    const second = await create('z/second')

    const moved = await wbDocumentMove(deps, {
      workspaceId: WS,
      documentId: second.documentId,
      path: 'moved/second',
    })

    expect(moved).toMatchObject({ documentId: second.documentId, from: 'z/second' })
    expect(await pathOf(second.documentId)).toBe('moved/second')
    expect(await pathOf(first.documentId)).toBe('a/first')
  })

  it('refuses an id the workspace does not hold, before moving anything', async () => {
    const deps = makeTestDeps()
    await seed(deps)
    await expect(
      wbDocumentMove(deps, {
        workspaceId: WS,
        documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        path: 'anywhere',
      }),
    ).rejects.toBeInstanceOf(WorkspaceDocumentNotFoundError)
  })

  it('treats a move onto its own path as nothing to do', async () => {
    const deps = makeTestDeps()
    const { create, pathOf } = await seed(deps)
    const doc = await create('same')
    const moved = await wbDocumentMove(deps, {
      workspaceId: WS,
      documentId: doc.documentId,
      path: 'same',
    })
    expect(moved.follow).toEqual({ updatedDocumentIds: [], failedDocumentIds: [] })
    expect(await pathOf(doc.documentId)).toBe('same')
  })
})
