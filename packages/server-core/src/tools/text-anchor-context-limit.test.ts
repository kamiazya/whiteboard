import { TEXT_ANCHOR_CONTEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { bodyEditInputSchema } from './body-edit.js'
import { createThreadEditTool } from './thread-edit.js'

const WORKSPACE_ID = 'ws-1'
const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'

const threadEditInputSchema = createThreadEditTool(makeTestDeps()).inputSchema

type Side = 'prefix' | 'suffix'

const anchorWith = (side: Side, length: number) => ({
  kind: 'text' as const,
  quote: { exact: 'passage', [side]: 'x'.repeat(length) },
  start: 0,
  end: 7,
})

/** Every tool op that accepts a text anchor, as the input it would parse. */
const ANCHOR_WRITERS: ReadonlyArray<
  readonly [string, (anchor: ReturnType<typeof anchorWith>) => z.ZodSafeParseResult<unknown>]
> = [
  [
    'wb_thread_edit thread.add',
    (anchor) =>
      threadEditInputSchema.safeParse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [{ op: 'thread.add', anchor, body: 'a note' }],
      }),
  ],
  [
    'wb_body_edit body.replace',
    (anchor) =>
      bodyEditInputSchema.safeParse({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        ops: [{ id: 'c1', op: 'body.replace', anchor, text: 'new', assumed: 'passage' }],
      }),
  ],
]

const SIDES: readonly Side[] = ['prefix', 'suffix']
const CASES = ANCHOR_WRITERS.flatMap(([tool, parse]) =>
  SIDES.map((side) => [tool, side, parse] as const),
)

describe("a text anchor's context is bounded where a tool accepts it", () => {
  it.each(CASES)('%s refuses a %s one character past the limit', (_tool, side, parse) => {
    const parsed = parse(anchorWith(side, TEXT_ANCHOR_CONTEXT_MAX_CHARS + 1))
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      expect.stringMatching(/context is longer than the 32-character limit/),
    ])
    expect(parsed.error?.issues[0]?.path.at(-1)).toBe(side)
  })

  it.each(CASES)('%s accepts a %s of exactly the limit', (_tool, side, parse) => {
    expect(parse(anchorWith(side, TEXT_ANCHOR_CONTEXT_MAX_CHARS)).success).toBe(true)
  })

  it.each(ANCHOR_WRITERS)('%s publishes the limit as maxLength', (tool) => {
    const schema = tool.startsWith('wb_thread_edit') ? threadEditInputSchema : bodyEditInputSchema
    const published = JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))
    const bounded = (field: Side) =>
      published.match(
        new RegExp(`"${field}":\\{[^{}]*"maxLength":${TEXT_ANCHOR_CONTEXT_MAX_CHARS}`, 'g'),
      )?.length ?? 0
    expect(bounded('prefix')).toBe(1)
    expect(bounded('suffix')).toBe(1)
  })
})
