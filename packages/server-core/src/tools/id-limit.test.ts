import {
  ID_LIMIT_PHRASE,
  ID_MAX_CHARS,
  MARKDOWN_LIMIT_PHRASE,
  MARKDOWN_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { DOCUMENT_ID, WORKSPACE_ID } from './_test-canvas-edit.js'
import { bodyEditInputSchema } from './body-edit.js'
import { canvasEditInputSchema } from './canvas-edit-ops.js'
import { createThreadEditTool } from './thread-edit.js'

const threadEditInputSchema = createThreadEditTool(makeTestDeps()).inputSchema

type Parse = (value: string) => z.ZodSafeParseResult<unknown>

const ids = { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }
const box = { x: 0, y: 0, width: 200, height: 60 }
const canvas = (op: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  canvasEditInputSchema.safeParse({ ...ids, mode: 'apply', ops: [op], ...extra })
const passage = { kind: 'text', quote: { exact: 'hello' }, start: 0, end: 5 }
const replace = (change: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  bodyEditInputSchema.safeParse({
    ...ids,
    ops: [
      { id: 'c1', op: 'body.replace', anchor: passage, text: 'hi', assumed: 'hello', ...change },
    ],
    ...extra,
  })

/**
 * Every id a caller chooses for something it CREATES. Each becomes a key in
 * the record and is repeated in every answer naming its element, and a
 * thread's or a proposal's names a container of its own.
 */
const CREATED_IDS: ReadonlyArray<readonly [string, Parse]> = [
  [
    'node.add node.id',
    (id) => canvas({ op: 'node.add', node: { id, type: 'text', text: 'a', ...box } }),
  ],
  [
    'edge.add edge.id',
    (id) => canvas({ op: 'edge.add', edge: { id, from: { node: 'a' }, to: { node: 'b' } } }),
  ],
  [
    'line.add line.id',
    (id) =>
      canvas({
        op: 'line.add',
        line: {
          id,
          from: { kind: 'point', point: { x: 0, y: 0 } },
          to: { kind: 'point', point: { x: 9, y: 9 } },
        },
      }),
  ],
  [
    'comment.add comment.id',
    (id) => canvas({ op: 'comment.add', comment: { id, x: 0, y: 0, text: 'a' } }),
  ],
  [
    'wb_canvas_edit proposalId',
    (id) =>
      canvas(
        { op: 'node.add', node: { type: 'text', text: 'a', ...box } },
        { mode: 'propose', proposalId: id },
      ),
  ],
  [
    'thread.add threadId',
    (threadId) =>
      threadEditInputSchema.safeParse({
        ...ids,
        ops: [{ op: 'thread.add', threadId, anchor: { kind: 'document' }, body: 'a note' }],
      }),
  ],
  ['wb_body_edit proposalId', (proposalId) => replace({}, { proposalId })],
  ['body.replace id', (id) => replace({ id })],
]

const messagesOf = (parsed: z.ZodSafeParseResult<unknown>) =>
  parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)

describe('an id a caller chooses for what it creates', () => {
  it.each(CREATED_IDS)('%s takes an id of exactly the limit', (_, parse) => {
    expect(parse('i'.repeat(ID_MAX_CHARS)).success).toBe(true)
  })

  it.each(CREATED_IDS)('%s refuses one character past it, naming the limit', (_, parse) => {
    expect(messagesOf(parse('i'.repeat(ID_MAX_CHARS + 1)))).toEqual([
      `an id is longer than ${ID_LIMIT_PHRASE}`,
    ])
  })

  it('holds an id to 256 characters', () => {
    // A literal: every other case reads the limit back from itself.
    expect(ID_MAX_CHARS).toBe(256)
  })

  it.each([
    ['node.patch', (id: string) => canvas({ op: 'node.patch', id, patch: { color: '1' } })],
    [
      'an edge end',
      (id: string) => canvas({ op: 'edge.add', edge: { from: { node: id }, to: { node: 'b' } } }),
    ],
    [
      'message.add',
      (threadId: string) =>
        threadEditInputSchema.safeParse({
          ...ids,
          ops: [{ op: 'message.add', threadId, body: 'a reply' }],
        }),
    ],
  ])('%s still names an element stored under a longer id', (_, parse) => {
    // Naming is not creating: an element written before the limit must stay reachable.
    expect(parse('i'.repeat(ID_MAX_CHARS * 4)).success).toBe(true)
  })
})

describe('what a proposed passage assumed', () => {
  it('takes a prior of exactly the markdown limit', () => {
    expect(replace({ assumed: 'a'.repeat(MARKDOWN_MAX_CHARS) }).success).toBe(true)
  })

  it('refuses one character past it, naming the limit', () => {
    expect(messagesOf(replace({ assumed: 'a'.repeat(MARKDOWN_MAX_CHARS + 1) }))).toEqual([
      `a passage's prior text is longer than ${MARKDOWN_LIMIT_PHRASE}`,
    ])
  })
})
