import { readMarkdownBody, readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { describe, expect, it } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasEditTool } from '../tools/canvas-edit.js'
import { wbDocumentCreate } from '../tools/document-crud.js'
import { loadOrCreateDocument, saveDocumentSnapshot } from '../tools/document-io.js'
import { createDocumentSetTool } from '../tools/document-set.js'
import { followReferencesAfterRename } from './follow-rename.js'

const WS = 'ws-follow'

async function seed(deps: ServerDeps) {
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  const create = (path: string, name?: string) =>
    wbDocumentCreate(deps, {
      workspaceId: WS,
      path,
      kind: 'markdown',
      ...(name === undefined ? {} : { name }),
    })
  const set = createDocumentSetTool(deps)
  const write = (documentId: string, body: string) =>
    set.execute({ workspaceId: WS, documentId, markdown: `---\ntype: note\n---\n${body}` })
  const bodyOf = async (documentId: string) =>
    readMarkdownBody(await loadOrCreateDocument(deps, WS, documentId as never))
  return { create, write, bodyOf }
}

const entriesBefore = (deps: ServerDeps) => deps.documentIndex.listDocuments({ workspaceId: WS })

describe('followReferencesAfterRename', () => {
  it('a path move repoints references written as the old path', async () => {
    const deps = makeTestDeps()
    const { create, write, bodyOf } = await seed(deps)
    const target = await create('design/login', 'Login flow')
    const source = await create('notes/daily')
    await write(source.documentId, 'see [[design/login]] and [[Login flow]] and [[unrelated]]')

    const before = await entriesBefore(deps)
    await deps.documentIndex.moveDocument({
      workspaceId: WS,
      from: 'design/login',
      to: 'archive/login',
    })
    const result = await followReferencesAfterRename(deps, {
      workspaceId: WS,
      entriesBefore: before,
      moves: [{ movedId: target.documentId, from: 'design/login', to: 'archive/login' }],
    })

    expect(result.updatedDocumentIds).toEqual([source.documentId])
    // The path form followed; the name form and the dead ref are untouched.
    expect(await bodyOf(source.documentId)).toBe(
      'see [[archive/login]] and [[Login flow]] and [[unrelated]]',
    )
  })

  it('rewrites spatial text nodes and file nodes too', async () => {
    const deps = makeTestDeps()
    const { create } = await seed(deps)
    const target = await create('design/login', 'Login flow')
    const canvas = await wbDocumentCreate(deps, { workspaceId: WS, path: 'board', kind: 'spatial' })
    await createCanvasEditTool(deps).execute({
      workspaceId: WS,
      documentId: canvas.documentId,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: {
            id: 't1',
            x: 0,
            y: 0,
            width: 100,
            height: 40,
            type: 'text',
            text: 'see [[design/login]]',
          },
        },
        {
          op: 'node.add',
          node: {
            id: 'f1',
            x: 0,
            y: 60,
            width: 100,
            height: 40,
            type: 'file',
            file: 'design/login',
          },
        },
      ],
    })

    const before = await entriesBefore(deps)
    await deps.documentIndex.moveDocument({
      workspaceId: WS,
      from: 'design/login',
      to: 'archive/login',
    })
    const result = await followReferencesAfterRename(deps, {
      workspaceId: WS,
      entriesBefore: before,
      moves: [{ movedId: target.documentId, from: 'design/login', to: 'archive/login' }],
    })

    expect(result.updatedDocumentIds).toEqual([canvas.documentId])
    const doc = await loadOrCreateDocument(deps, WS, canvas.documentId as never)
    const spatial = readSpatialCanvas(doc)
    expect(spatial.nodes.find((n) => n.id === 't1')).toMatchObject({
      text: 'see [[archive/login]]',
    })
    expect(spatial.nodes.find((n) => n.id === 'f1')).toMatchObject({ file: 'archive/login' })
  })

  it('a subtree move follows references to a descendant', async () => {
    const deps = makeTestDeps()
    const { create, write, bodyOf } = await seed(deps)
    const parent = await create('folder')
    const child = await create('folder/child')
    const source = await create('notes/daily')
    await write(source.documentId, 'see [[folder/child]] and [[folder]]')

    const before = await entriesBefore(deps)
    await deps.documentIndex.moveDocument({ workspaceId: WS, from: 'folder', to: 'archive/folder' })
    await followReferencesAfterRename(deps, {
      workspaceId: WS,
      entriesBefore: before,
      moves: [
        { movedId: parent.documentId, from: 'folder', to: 'archive/folder' },
        { movedId: child.documentId, from: 'folder/child', to: 'archive/folder/child' },
      ],
    })

    expect(await bodyOf(source.documentId)).toBe(
      'see [[archive/folder/child]] and [[archive/folder]]',
    )
  })

  it('a record the current schema cannot read survives the rewrite', async () => {
    // readSpatialCanvas drops what it cannot parse and a whole-canvas write
    // would then DELETE it — the rewrite must therefore write only the
    // nodes it changed, and this is the test that fails if it ever goes
    // back to a resync.
    const deps = makeTestDeps()
    const { create } = await seed(deps)
    const target = await create('design/login', 'Login flow')
    const board = await wbDocumentCreate(deps, { workspaceId: WS, path: 'board', kind: 'spatial' })
    await createCanvasEditTool(deps).execute({
      workspaceId: WS,
      documentId: board.documentId,
      mode: 'apply',
      ops: [
        {
          op: 'node.add',
          node: {
            id: 't1',
            x: 0,
            y: 0,
            width: 100,
            height: 40,
            type: 'text',
            text: 'see [[design/login]]',
          },
        },
      ],
    })
    // A record from "another version": a shape today's spatialNodeSchema
    // rejects, planted straight into the nodes map.
    {
      const doc = await loadOrCreateDocument(deps, WS, board.documentId as never)
      doc.getMap('nodes').set('from-the-future', { type: 'hologram', shimmer: true })
      doc.commit()
      await saveDocumentSnapshot(deps, WS, board.documentId as never, doc)
    }

    const before = await entriesBefore(deps)
    await deps.documentIndex.moveDocument({
      workspaceId: WS,
      from: 'design/login',
      to: 'archive/login',
    })
    const result = await followReferencesAfterRename(deps, {
      workspaceId: WS,
      entriesBefore: before,
      moves: [{ movedId: target.documentId, from: 'design/login', to: 'archive/login' }],
    })

    expect(result.updatedDocumentIds).toEqual([board.documentId])
    const doc = await loadOrCreateDocument(deps, WS, board.documentId as never)
    expect(readSpatialCanvas(doc).nodes.find((n) => n.id === 't1')).toMatchObject({
      text: 'see [[archive/login]]',
    })
    // The unreadable record is still there, byte-for-byte.
    expect(doc.getMap('nodes').get('from-the-future')).toEqual({
      type: 'hologram',
      shimmer: true,
    })
  })

  it('touches nothing when no reference named the moved document', async () => {
    const deps = makeTestDeps()
    const { create, write, bodyOf } = await seed(deps)
    const target = await create('design/login', 'Login flow')
    const source = await create('notes/daily')
    await write(source.documentId, 'no references here, and [[somewhere/else]] is dead')

    const before = await entriesBefore(deps)
    await deps.documentIndex.moveDocument({
      workspaceId: WS,
      from: 'design/login',
      to: 'archive/login',
    })
    const result = await followReferencesAfterRename(deps, {
      workspaceId: WS,
      entriesBefore: before,
      moves: [{ movedId: target.documentId, from: 'design/login', to: 'archive/login' }],
    })

    expect(result.updatedDocumentIds).toEqual([])
    expect(await bodyOf(source.documentId)).toBe(
      'no references here, and [[somewhere/else]] is dead',
    )
  })
})
