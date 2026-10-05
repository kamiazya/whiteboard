import { OPS_PER_CALL_MAX } from '@kamiazya/whiteboard-model'
import { describe, expect, test } from 'vitest'
import type { z } from 'zod'
import { FakeDocumentStore } from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { bodyEditInputSchema } from './body-edit.js'
import { canvasEditInputSchema } from './canvas-edit-ops.js'
import { createThreadEditTool } from './thread-edit.js'

const target = { workspaceId: 'ws-1', documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7' }
const passage = { kind: 'text', quote: { exact: 'ab' }, start: 0, end: 2 }

const store = new FakeDocumentStore()
const threadEditInputSchema = createThreadEditTool(
  makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
).inputSchema

// Every op-batch tool reads one ceiling, so each is held to it by the same
// two cases: the ceiling itself passes and one more is refused at the schema,
// before a single op is resolved against a body.
const BATCH_TOOLS: readonly {
  readonly name: string
  readonly schema: z.ZodType
  readonly op: (index: number) => unknown
}[] = [
  {
    name: 'wb_canvas_edit',
    schema: canvasEditInputSchema,
    op: () => ({ op: 'node.remove', id: 'x' }),
  },
  {
    name: 'wb_body_edit',
    schema: bodyEditInputSchema,
    op: (index) => ({
      id: `c${index}`,
      op: 'body.replace',
      anchor: passage,
      text: 'AB',
      assumed: 'ab',
    }),
  },
  {
    name: 'wb_thread_edit',
    schema: threadEditInputSchema,
    op: () => ({ op: 'thread.add', anchor: passage, body: 'note' }),
  },
]

describe.each(BATCH_TOOLS)('$name — the op batch ceiling', ({ schema, op }) => {
  const batch = (length: number) => ({ ...target, ops: Array.from({ length }, (_, i) => op(i)) })

  test('accepts a batch at the ceiling', () => {
    expect(schema.safeParse(batch(OPS_PER_CALL_MAX)).success).toBe(true)
  })

  test('refuses a batch one past the ceiling, naming the limit', () => {
    const parsed = schema.safeParse(batch(OPS_PER_CALL_MAX + 1))
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message).join('\n')).toContain(
      `${OPS_PER_CALL_MAX}-op limit`,
    )
  })
})
