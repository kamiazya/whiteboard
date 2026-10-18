/**
 * The per-document ceilings on open comment threads and open proposed
 * changes, as the tools hold them: every surface that opens one —
 * `wb_thread_edit`, `wb_canvas_edit`'s `comment.add` and its propose mode,
 * and `wb_body_edit`'s proposals — refuses the op that would take a document
 * past its bound, counting what the document already holds open.
 */
import {
  writeCommentThread,
  writeDocumentKind,
  writeMarkdownBody,
  writeProposal,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  DOCUMENT_MAX_OPEN_CHANGES,
  DOCUMENT_MAX_OPEN_THREADS,
  type ProposedChange,
  type SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createBodyEditTool } from './body-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { createThreadEditTool } from './thread-edit.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const BODY = 'Ship on Thursday. Review on Friday.\n'

const BOARD: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 100, height: 40, text: 'A' })],
  edges: [],
}

function threads(open: number, resolved = 0) {
  return (doc: LoroDoc) => {
    const write = (id: string, status: 'open' | 'resolved') =>
      writeCommentThread(doc, {
        id,
        anchor: { kind: 'document' },
        status,
        messages: [{ id: `${id}-m1`, body: 'is this right?' }],
      })
    for (let i = 0; i < open; i += 1) write(`t${i}`, 'open')
    for (let i = 0; i < resolved; i += 1) write(`r${i}`, 'resolved')
  }
}

function openChanges(count: number, decided = 0) {
  return (doc: LoroDoc) => {
    const changes: ProposedChange[] = Array.from({ length: count + decided }, (_, i) => ({
      id: `ch${i}`,
      status: i < count ? 'open' : 'dismissed',
      op: 'node.add',
      node: textNode({ id: `p${i}`, x: 0, y: 200, width: 100, height: 40, text: 'x' }),
    }))
    writeProposal(doc, { id: 'p1', changes })
  }
}

async function seeded(kind: 'spatial' | 'markdown', ...seeds: ((doc: LoroDoc) => void)[]) {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, kind)
    if (kind === 'spatial') writeSpatialCanvas(doc, BOARD)
    else writeMarkdownBody(doc, BODY)
    for (const seed of seeds) seed(doc)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    path: 'doc',
    kind,
  })
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

const target = { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }
const openThread = { op: 'thread.add', anchor: { kind: 'document' }, body: 'one more' } as const
const pastThreads = new RegExp(
  `${DOCUMENT_MAX_OPEN_THREADS + 1} open comment threads, past the limit of ${DOCUMENT_MAX_OPEN_THREADS} open comment threads for one document`,
)
const pastChanges = new RegExp(
  `${DOCUMENT_MAX_OPEN_CHANGES + 1} open proposed changes, past the limit of ${DOCUMENT_MAX_OPEN_CHANGES} open proposed changes for one document`,
)

describe('wb_thread_edit holds the open-thread ceiling', () => {
  test('a thread.add past the ceiling is refused by name', async () => {
    const deps = await seeded('markdown', threads(DOCUMENT_MAX_OPEN_THREADS))
    await expect(
      createThreadEditTool(deps).execute({ ...target, ops: [openThread] }),
    ).rejects.toThrow(pastThreads)
  })

  test('reopening a resolved thread past the ceiling is refused', async () => {
    const deps = await seeded('markdown', threads(DOCUMENT_MAX_OPEN_THREADS, 1))
    await expect(
      createThreadEditTool(deps).execute({
        ...target,
        ops: [{ op: 'thread.resolve', threadId: 'r0', resolved: false }],
      }),
    ).rejects.toThrow(pastThreads)
  })

  test('resolving one in the same batch makes room for another', async () => {
    const deps = await seeded('markdown', threads(DOCUMENT_MAX_OPEN_THREADS))
    const result = await createThreadEditTool(deps).execute({
      ...target,
      ops: [{ op: 'thread.resolve', threadId: 't0' }, openThread],
    })
    expect(result.threads.filter((thread) => thread.status === 'open')).toHaveLength(
      DOCUMENT_MAX_OPEN_THREADS,
    )
  })
})

describe('wb_canvas_edit holds the open-thread ceiling', () => {
  test('a comment.add past the ceiling is refused by name', async () => {
    const deps = await seeded('spatial', threads(DOCUMENT_MAX_OPEN_THREADS))
    await expect(
      createCanvasEditTool(deps).execute({
        ...target,
        mode: 'apply',
        ops: [{ op: 'comment.add', comment: { text: 'one more', targetNodeId: 'a' } }],
      }),
    ).rejects.toThrow(pastThreads)
  })
})

describe('the open-change ceiling counts every open proposal, not only this one', () => {
  test("wb_canvas_edit's propose mode is refused past it", async () => {
    const deps = await seeded('spatial', openChanges(DOCUMENT_MAX_OPEN_CHANGES))
    await expect(
      createCanvasEditTool(deps).execute({
        ...target,
        mode: 'propose',
        ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
      }),
    ).rejects.toThrow(pastChanges)
  })

  test('decided changes do not count', async () => {
    const deps = await seeded('spatial', openChanges(DOCUMENT_MAX_OPEN_CHANGES - 1, 5))
    const result = await createCanvasEditTool(deps).execute({
      ...target,
      mode: 'propose',
      ops: [{ op: 'node.patch', id: 'a', patch: { x: 400 } }],
    })
    expect(result.proposed?.changes).toHaveLength(1)
  })

  test("wb_body_edit's proposal is refused past it", async () => {
    const deps = await seeded('markdown', openChanges(DOCUMENT_MAX_OPEN_CHANGES))
    const exact = 'Thursday'
    const start = BODY.indexOf(exact)
    await expect(
      createBodyEditTool(deps).execute({
        ...target,
        ops: [
          {
            id: 'c1',
            op: 'body.replace',
            anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
            text: 'Friday',
            assumed: exact,
          },
        ],
      }),
    ).rejects.toThrow(pastChanges)
  })
})
