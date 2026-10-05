import {
  COMMENT_MESSAGE_MAX_CHARS,
  commentMessageInputSchema,
  LABEL_MAX_CHARS,
  labelInputSchema,
} from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { DOCUMENT_ID, makeDeps, WORKSPACE_ID } from './_test-canvas-edit.js'
import { canvasEditInputSchema } from './canvas-edit-ops.js'
import { createThreadEditTool } from './thread-edit.js'

type Parsed = { success: boolean; error?: { issues: { message: string }[] } }

function refusalMessages(parsed: unknown): string[] {
  const result = parsed as Parsed
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? [])
}

const canvasBatch = (op: Record<string, unknown>) =>
  canvasEditInputSchema.safeParse({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode: 'apply',
    ops: [op],
  })

const threadInput = createThreadEditTool(makeDeps(new FakeDocumentStore())).inputSchema
const threadBatch = (op: Record<string, unknown>) =>
  threadInput.safeParse({ workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID, ops: [op] })

const pointEnd = (x: number) => ({ kind: 'point', point: { x, y: 0 } })

/** Every op that hands a label to the write path. */
const LABEL_WRITERS: ReadonlyArray<readonly [string, (label: string) => unknown]> = [
  [
    'node.add (group)',
    (label) =>
      canvasBatch({
        op: 'node.add',
        node: { type: 'group', label, x: 0, y: 0, width: 200, height: 100 },
      }),
  ],
  ['node.patch', (label) => canvasBatch({ op: 'node.patch', id: 'g', patch: { label } })],
  [
    'edge.add',
    (label) =>
      canvasBatch({ op: 'edge.add', edge: { from: { node: 'a' }, to: { node: 'b' }, label } }),
  ],
  ['edge.patch', (label) => canvasBatch({ op: 'edge.patch', id: 'e', patch: { label } })],
  [
    'line.add',
    (label) =>
      canvasBatch({ op: 'line.add', line: { from: pointEnd(0), to: pointEnd(100), label } }),
  ],
  ['line.patch', (label) => canvasBatch({ op: 'line.patch', id: 'l', patch: { label } })],
]

/** Every op that hands a comment message to the write path. */
const MESSAGE_WRITERS: ReadonlyArray<readonly [string, (body: string) => unknown]> = [
  ['thread.add', (body) => threadBatch({ op: 'thread.add', anchor: { kind: 'document' }, body })],
  ['message.add', (body) => threadBatch({ op: 'message.add', threadId: 't1', body })],
  ['comment.add', (text) => canvasBatch({ op: 'comment.add', comment: { text, x: 0, y: 0 } })],
]

describe('the size of one label is declared once', () => {
  const over = 'x'.repeat(LABEL_MAX_CHARS + 1)
  it.each(
    LABEL_WRITERS,
  )('%s refuses one character past the limit, in the same words', (_op, parse) => {
    const expected = refusalMessages(labelInputSchema.safeParse(over))
    expect(expected[0]).toMatch(/-character limit; a longer text belongs in a text node/)
    expect(refusalMessages(parse(over))).toEqual(expected)
  })

  it.each(LABEL_WRITERS)('%s accepts a label of exactly the limit', (_op, parse) => {
    expect((parse('x'.repeat(LABEL_MAX_CHARS)) as Parsed).success).toBe(true)
  })
})

describe('the size of one comment message is declared once', () => {
  const over = 'x'.repeat(COMMENT_MESSAGE_MAX_CHARS + 1)
  it.each(
    MESSAGE_WRITERS,
  )('%s refuses one character past the limit, in the same words', (_op, parse) => {
    const expected = refusalMessages(commentMessageInputSchema.safeParse(over))
    expect(expected[0]).toMatch(/-character limit; split it across replies/)
    expect(refusalMessages(parse(over))).toEqual(expected)
  })

  it.each(MESSAGE_WRITERS)('%s accepts a message of exactly the limit', (_op, parse) => {
    expect((parse('x'.repeat(COMMENT_MESSAGE_MAX_CHARS)) as Parsed).success).toBe(true)
  })
})
