/**
 * The quote a text anchor carries, as both tools that write one accept it:
 * `wb_thread_edit`'s `thread.add` and `wb_body_edit`'s `body.replace`. Every
 * reader of the body re-finds each passage by its quote after each edit, so
 * the bound is held where an agent writes, as the sync judge holds it where a
 * peer does.
 */
import {
  TEXT_ANCHOR_QUOTE_LIMIT_PHRASE,
  TEXT_ANCHOR_QUOTE_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import { describe, expect, test } from 'vitest'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createBodyEditTool } from './body-edit.js'
import { createThreadEditTool } from './thread-edit.js'

const quoting = (chars: number) => ({
  kind: 'text' as const,
  quote: { exact: 'q'.repeat(chars) },
  start: 0,
  end: chars,
})

const CALLS = {
  'wb_thread_edit thread.add': (chars: number) =>
    createThreadEditTool(makeTestDeps()).inputSchema.safeParse({
      workspaceId: 'ws-1',
      documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
      ops: [{ op: 'thread.add', anchor: quoting(chars), body: 'about this' }],
    }),
  'wb_body_edit body.replace': (chars: number) =>
    createBodyEditTool(makeTestDeps()).inputSchema.safeParse({
      workspaceId: 'ws-1',
      documentId: '01H8XJZ9K5N4M3P2Q1R0S9T8V7',
      mode: 'propose',
      ops: [{ id: 'c1', op: 'body.replace', anchor: quoting(chars), text: 'instead', assumed: '' }],
    }),
} as const

describe.each(Object.keys(CALLS) as (keyof typeof CALLS)[])('%s', (call) => {
  test('refuses a quote past the bound, naming it', () => {
    const refused = CALLS[call](TEXT_ANCHOR_QUOTE_MAX_CHARS + 1)
    expect(refused.success).toBe(false)
    expect(refused.error?.issues.map((issue) => issue.message).join('\n')).toContain(
      TEXT_ANCHOR_QUOTE_LIMIT_PHRASE,
    )
  })

  test('accepts a quote at the bound', () => {
    expect(CALLS[call](TEXT_ANCHOR_QUOTE_MAX_CHARS).error?.issues).toBeUndefined()
  })
})
