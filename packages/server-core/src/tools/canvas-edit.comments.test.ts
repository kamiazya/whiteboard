// `wb_canvas_edit` carries no comment verbs (ADR-0026 decision 6): a
// conversation is the document's annotation layer, written through
// `wb_thread_edit` on a canvas and a note alike. What is pinned here is the
// refusal a model gets when it reaches for the retired verbs, and that a
// canvas batch leaves the layer exactly as it found it.

import {
  readAnnotations,
  writeCommentThread,
  writeDocumentKind,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { CommentThread, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, test } from 'vitest'
import { loadDocument } from '../document-io.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, WORKSPACE_ID } from './_test-canvas-edit.js'
import { createCanvasEditTool } from './canvas-edit.js'

const NODE: SpatialCanvas['nodes'][number] = textNode({
  id: 'n1',
  x: 100,
  y: 40,
  width: 200,
  height: 80,
  text: 'content',
})

const THREAD: CommentThread = {
  id: 't1',
  anchor: { kind: 'spatial', x: 9, y: 9, nodeId: 'n1' },
  status: 'open',
  messages: [{ id: 't1-m1', body: 'still here after the batch' }],
}

describe('wb_canvas_edit has no comment verbs', () => {
  test.each([
    ['comment.add', { comment: { x: 1, y: 2, text: 'hello' } }],
    ['comment.resolve', { id: 'c1' }],
    ['comment.remove', { id: 'c1' }],
  ])('%s is refused by the schema, and the refusal names wb_thread_edit', (op, rest) => {
    const tool = createCanvasEditTool(makeDeps(new FakeDocumentStore()))
    const refused = tool.inputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [{ op, ...rest }],
    })
    expect(refused.success).toBe(false)
    expect(refused.error?.issues.map((issue) => issue.message).join('\n')).toMatch(/wb_thread_edit/)
  })

  test('a batch leaves the document comment threads exactly as it found them', async () => {
    const store = new FakeDocumentStore()
    await seedDoc(store, DOCUMENT_ID, (doc) => {
      writeDocumentKind(doc, 'spatial')
      writeSpatialCanvas(doc, { nodes: [NODE], edges: [] })
      writeCommentThread(doc, THREAD)
    })
    await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
    const before = readAnnotations(
      (await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)).doc,
    )
    expect(before.map((thread) => thread.id)).toEqual(['t1'])

    await createCanvasEditTool(makeDeps(store)).execute({
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode: 'apply',
      ops: [
        { op: 'node.patch', id: 'n1', patch: { x: 111 } },
        { op: 'node.add', node: { type: 'text', text: 'beside it' } },
      ],
    })

    const { doc } = await loadDocument(makeDeps(store), WORKSPACE_ID, DOCUMENT_ID)
    expect(readAnnotations(doc)).toEqual(before)
  })
})
