// The annotation layer's shape (ADR-0026): a THREAD is the anchored unit and
// comments are the messages in it, and the anchor is the only part that
// varies by document format. These tests pin the three things a later reader
// would otherwise have to infer — what belongs to the thread rather than to a
// message, that every anchor arm is "an optional object reference plus a
// positional fallback", and that today's flat comment is a one-message thread.
import { describe, expect, it } from 'vitest'
import {
  type AnnotationAnchor,
  annotationAnchorSchema,
  commentMessageSchema,
  commentThreadSchema,
  compareMessages,
  threadFromCanvasComment,
} from './annotation.js'
import type { CanvasComment } from './spatial.js'

const SPATIAL: AnnotationAnchor = { kind: 'spatial', x: 10, y: 20 }

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    anchor: SPATIAL,
    status: 'open',
    messages: [{ id: 'm1', body: 'first' }],
    ...overrides,
  }
}

describe('annotationAnchorSchema', () => {
  it('accepts a spatial anchor with and without its object reference', () => {
    expect(annotationAnchorSchema.safeParse({ kind: 'spatial', x: 1, y: 2 }).success).toBe(true)
    expect(
      annotationAnchorSchema.safeParse({ kind: 'spatial', nodeId: 'n1', x: 1, y: 2 }).success,
    ).toBe(true)
  })

  it('requires integer spatial coordinates, because a reader drops a comment that fails the schema', () => {
    // The same rule `canvasCommentSchema` already carries: a fractional
    // anchor from a zoomed viewport survives the session and vanishes on the
    // next read.
    expect(annotationAnchorSchema.safeParse({ kind: 'spatial', x: 1.5, y: 2 }).success).toBe(false)
  })

  it('accepts a text anchor carrying both a quote and an offset', () => {
    const anchor = {
      kind: 'text',
      quote: { prefix: 'the ', exact: 'launch plan', suffix: ' is' },
      start: 4,
      end: 15,
    }
    expect(annotationAnchorSchema.safeParse(anchor).success).toBe(true)
  })

  it('rejects a text anchor with no quote: an offset alone cannot survive an edit above it', () => {
    expect(annotationAnchorSchema.safeParse({ kind: 'text', start: 4, end: 15 }).success).toBe(
      false,
    )
  })

  it('rejects an empty quote and a backwards range', () => {
    const quote = { prefix: '', exact: '', suffix: '' }
    expect(
      annotationAnchorSchema.safeParse({ kind: 'text', quote, start: 0, end: 0 }).success,
    ).toBe(false)
    const ok = { prefix: '', exact: 'x', suffix: '' }
    expect(
      annotationAnchorSchema.safeParse({ kind: 'text', quote: ok, start: 9, end: 4 }).success,
    ).toBe(false)
  })

  it('rejects an unknown format arm rather than passing it through', () => {
    // The union is closed on purpose (ADR-0026 decision 3): a new format is a
    // new arm here, which is what makes every renderer's switch exhaustive.
    expect(annotationAnchorSchema.safeParse({ kind: 'audio', at: 3 }).success).toBe(false)
  })
})

describe('commentThreadSchema', () => {
  it('carries the anchor and the status, and at least one message', () => {
    expect(commentThreadSchema.safeParse(thread()).success).toBe(true)
    expect(commentThreadSchema.safeParse(thread({ messages: [] })).success).toBe(false)
  })

  it('has no resolved flag on a message: a conversation is what gets closed', () => {
    // ADR-0026 decision 2. With `resolved` on a message and replies beside
    // it, "which one's flag counts?" has no defensible answer.
    expect(commentMessageSchema.safeParse({ id: 'm1', body: 'x', resolved: true }).success).toBe(
      false,
    )
    expect(commentThreadSchema.safeParse(thread({ status: 'resolved' })).success).toBe(true)
    expect(commentThreadSchema.safeParse(thread({ status: 'archived' })).success).toBe(false)
  })

  it('has no anchor on a message: a reply inherits the thread’s', () => {
    expect(commentMessageSchema.safeParse({ id: 'm1', body: 'x', anchor: SPATIAL }).success).toBe(
      false,
    )
  })
})

describe('compareMessages', () => {
  it('orders by createdAt, then by id, so two peers reading the same thread see the same order', () => {
    const a = { id: 'b', body: 'x', createdAt: '2026-09-02T00:00:00.000Z' }
    const b = { id: 'a', body: 'x', createdAt: '2026-09-02T00:00:01.000Z' }
    expect([b, a].sort(compareMessages).map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('breaks a timestamp tie by id rather than leaving it to sort stability', () => {
    const at = '2026-09-02T00:00:00.000Z'
    const a = { id: 'a', body: 'x', createdAt: at }
    const b = { id: 'b', body: 'x', createdAt: at }
    expect([b, a].sort(compareMessages).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('sorts a message with no timestamp before one that has it, deterministically', () => {
    // `createdAt` is optional (identity and time are keeper concerns), so the
    // comparator must still be total: an absent timestamp is the earliest.
    const none = { id: 'z', body: 'x' }
    const dated = { id: 'a', body: 'x', createdAt: '2026-09-02T00:00:00.000Z' }
    expect([dated, none].sort(compareMessages).map((m) => m.id)).toEqual(['z', 'a'])
  })
})

describe('threadFromCanvasComment', () => {
  it("turns today's flat comment into a one-message thread, keeping its id", () => {
    const comment: CanvasComment = {
      id: 'c1',
      x: 40,
      y: 50,
      text: 'tighten this',
      createdAt: '2026-09-02T00:00:00.000Z',
      author: 'human:yuki',
    }
    expect(threadFromCanvasComment(comment)).toEqual({
      id: 'c1',
      anchor: { kind: 'spatial', x: 40, y: 50 },
      status: 'open',
      createdAt: '2026-09-02T00:00:00.000Z',
      messages: [
        {
          id: 'c1',
          body: 'tighten this',
          createdAt: '2026-09-02T00:00:00.000Z',
          author: 'human:yuki',
        },
      ],
    })
  })

  it('carries the node reference into the anchor and resolution into the status', () => {
    const migrated = threadFromCanvasComment({
      id: 'c2',
      x: 1,
      y: 2,
      text: 'done',
      targetNodeId: 'n1',
      resolved: true,
    })
    expect(migrated.anchor).toEqual({ kind: 'spatial', nodeId: 'n1', x: 1, y: 2 })
    expect(migrated.status).toBe('resolved')
  })

  it('produces a thread that validates, for every comment that validated', () => {
    // The migration is only mechanical if its output is always legal. A
    // comment with nothing optional set is the case that would catch an
    // over-required thread schema.
    const bare = threadFromCanvasComment({ id: 'c3', x: 0, y: 0, text: 'x' })
    expect(commentThreadSchema.safeParse(bare).success).toBe(true)
  })

  it('keeps the message id equal to the thread id for a migrated comment', () => {
    // Deliberate: the comment's id is what every existing anchor, MCP call
    // and test already names, so the THREAD keeps it. The single message
    // borrowing it means a migrated record has no id nobody has seen before.
    const migrated = threadFromCanvasComment({ id: 'c4', x: 0, y: 0, text: 'x' })
    expect(migrated.messages[0]?.id).toBe(migrated.id)
  })
})
