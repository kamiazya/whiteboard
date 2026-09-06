// The comment ops of `wb_canvas_edit` (ADR-0024): comment.add /
// comment.resolve — and, pinned here, NO comment.remove (ADR-0025 decision
// 2: resolving is the only close, for agents and people alike) — plus the
// preservation rule the layer
// depends on — a batch writes back the WHOLE canvas, so everything the batch
// did not touch (the canvas-level extension, every stored comment) must
// survive the save.

import { writeDocumentKind, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { okfTimestampSchema, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { describe, expect, test } from 'vitest'
import type { ServerDeps } from '../server-deps.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createCanvasEditTool } from './canvas-edit.js'
import { createCanvasSnapshotTool } from './canvas-snapshot.js'
import { loadDocument } from './document-io.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

function makeDeps(documentStore: FakeDocumentStore): ServerDeps {
  return makeTestDeps({
    documentStore: documentStore,
    documentIndex: documentStore.documentIndex,
  })
}

async function seedCanvas(store: FakeDocumentStore, canvas: SpatialCanvas): Promise<void> {
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'spatial')
    writeSpatialCanvas(doc, canvas)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
}

const NODE: SpatialCanvas['nodes'][number] = {
  id: 'n1',
  type: 'text',
  x: 100,
  y: 40,
  width: 200,
  height: 80,
  text: 'content',
}

async function storedComments(store: FakeDocumentStore) {
  const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
  return canvas['x-whiteboard']?.comments ?? []
}

describe('wb_canvas_edit comment ops', () => {
  test('comment.add anchors at the given point, mints an id, stamps createdAt, and reports it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [NODE], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    const result = await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'comment.add', comment: { x: 400, y: 60, text: 'この矢印は逆では?' } }],
    })

    const comments = await storedComments(store)
    expect(comments).toHaveLength(1)
    const comment = comments[0]
    expect(comment?.x).toBe(400)
    expect(comment?.y).toBe(60)
    expect(comment?.text).toBe('この矢印は逆では?')
    // Stamped by the server so the record orders without trusting callers;
    // an OKF timestamp, not merely "some string".
    expect(okfTimestampSchema.safeParse(comment?.createdAt).success).toBe(true)
    expect(result.touched.comments).toEqual([comment?.id])
    expect(result.snapshot.comments).toEqual(comments)
  })

  test('comment.add with only a target node anchors at that node top-right corner', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [NODE], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'comment.add', comment: { targetNodeId: 'n1', text: 'rename this' } }],
    })

    const [comment] = await storedComments(store)
    expect(comment?.targetNodeId).toBe('n1')
    expect(comment?.x).toBe(NODE.x + NODE.width)
    expect(comment?.y).toBe(NODE.y)
  })

  test('comment.add refuses an anchorless comment naming the op, and applies nothing', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [NODE], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))

    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [
          { op: 'node.add', node: { type: 'text', text: 'should not land' } },
          { op: 'comment.add', comment: { targetNodeId: 'missing', text: 'about nothing' } },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/comment\.add/) })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas.nodes).toHaveLength(1)
    expect(canvas['x-whiteboard']?.comments ?? []).toHaveLength(0)
  })

  test('comment.resolve marks the record and comment.resolve with resolved:false reopens it', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [],
      edges: [],
      'x-whiteboard': { comments: [{ id: 'c1', x: 0, y: 0, text: 'open question' }] },
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'comment.resolve', id: 'c1' }],
    })
    expect((await storedComments(store))[0]?.resolved).toBe(true)

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'comment.resolve', id: 'c1', resolved: false }],
    })
    // Reopened, and read back as an open comment with no `resolved` field.
    // The thread plane stores one bit for a two-value status (ADR-0026), so
    // the projection emits the canonical encoding of each state — and
    // `canvasCommentSchema` already made absent and `false` the same state.
    // Asserting the MEANING is what this test is about; the encoding is
    // pinned by `comment-source-of-truth.test.ts`.
    expect((await storedComments(store))[0]?.resolved).toBeFalsy()
  })

  test('there is no comment.remove op: the batch is refused whole and the comment stays', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [],
      edges: [],
      'x-whiteboard': { comments: [{ id: 'c1', x: 0, y: 0, text: 'kept' }] },
    })
    const tool = createCanvasEditTool(makeDeps(store))

    // The op union is the contract the SDK validates every call against
    // BEFORE `execute` runs, so a guessed verb is refused with nothing
    // written — including the rest of the batch. Asserted on the schema the
    // tool registers, which is the same object the SDK is handed.
    const refused = tool.inputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'comment.remove', id: 'c1' }],
    })
    expect(refused.success).toBe(false)
    expect(
      JSON.stringify(
        tool.inputSchema.safeParse({
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          mode: 'apply',
          ops: [{ op: 'comment.resolve', id: 'c1' }],
        }).success,
      ),
    ).toBe('true')
    expect((await storedComments(store)).map((comment) => comment.id)).toEqual(['c1'])
  })

  test('comment.resolve on an unknown id fails loudly', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, { nodes: [], edges: [] })
    const tool = createCanvasEditTool(makeDeps(store))
    await expect(
      tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'comment.resolve', id: 'nope' }],
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/"nope"/) })
  })

  test('a batch that never mentions comments preserves them AND the rendering preferences', async () => {
    // The regression this file exists for: the batch used to write back
    // `{ nodes, edges }` alone, which deletes the stored canvas-level
    // extension (edge routing) — and would delete every comment.
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [NODE],
      edges: [],
      'x-whiteboard': {
        edgeRouting: { style: 'orthogonal' },
        comments: [{ id: 'c1', x: 9, y: 9, text: 'still here after the batch' }],
      },
    })
    const tool = createCanvasEditTool(makeDeps(store))

    await tool.execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op: 'node.patch', id: 'n1', patch: { x: 111 } }],
    })

    const { canvas } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(canvas['x-whiteboard']?.edgeRouting).toEqual({ style: 'orthogonal' })
    expect(canvas['x-whiteboard']?.comments).toEqual([
      { id: 'c1', x: 9, y: 9, text: 'still here after the batch' },
    ])
  })

  test('wb_canvas_snapshot carries the comments so a reader sees the conversation', async () => {
    const store = new FakeDocumentStore()
    await seedCanvas(store, {
      nodes: [NODE],
      edges: [],
      'x-whiteboard': {
        comments: [{ id: 'c1', x: 1, y: 2, text: 'feedback', author: 'human:reviewer' }],
      },
    })
    const tool = createCanvasSnapshotTool(makeDeps(store))

    const result = await tool.execute({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID })
    expect(result.comments).toEqual([
      { id: 'c1', x: 1, y: 2, text: 'feedback', author: 'human:reviewer' },
    ])
  })
})
