// The annotation layer's shape (ADR-0026): a THREAD is the anchored unit and
// comments are the messages in it, and the anchor is the only part that
// varies by document format. These tests pin the three things a later reader
// would otherwise have to infer — what belongs to the thread rather than to a
// message, that every anchor arm is "an optional object reference plus a
// positional fallback", and that today's flat comment is a one-message thread.
import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_ANCHOR_KINDS,
  type AnnotationAnchor,
  annotationAnchorSchema,
  type CommentThread,
  canvasCommentFromThread,
  commentMessageSchema,
  commentThreadSchema,
  compareMessages,
  threadFromCanvasComment,
} from './annotation.js'
import type { CanvasComment } from './spatial.js'
import { annotationAnchorArbitrary } from './test-utils/arbitraries.js'
import { fc } from './test-utils/fast-check.js'

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

  it('lets a spatial anchor name an edge, the way it names a node — but never both', () => {
    // An edge is as much an object of the canvas as a node: the surface is
    // the arm, the reference names an object on it.
    expect(
      annotationAnchorSchema.safeParse({ kind: 'spatial', edgeId: 'e1', x: 1, y: 2 }).success,
    ).toBe(true)
    expect(
      annotationAnchorSchema.safeParse({ kind: 'spatial', nodeId: 'n1', edgeId: 'e1', x: 1, y: 2 })
        .success,
    ).toBe(false)
  })

  it('lets a text anchor name the node whose text holds the passage', () => {
    const anchor = { kind: 'text', nodeId: 'n1', quote: { exact: 'launch' }, start: 4, end: 10 }
    expect(annotationAnchorSchema.safeParse(anchor).success).toBe(true)
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

describe('the generator covers every arm the schema declares', () => {
  // The closest thing an anchor has to a coverage ledger: a property that
  // only ever drew the spatial arm would say nothing about the shape's
  // reason for existing, and nothing would fail when a third arm arrived.
  // The kinds are read off the schema, so this cannot go stale by hand.
  it('draws each kind, and each reference a spatial anchor may carry', () => {
    const seen = new Set<string>()
    fc.assert(
      fc.property(annotationAnchorArbitrary, (anchor) => {
        seen.add(anchor.kind)
        if (anchor.kind === 'spatial') {
          seen.add(
            anchor.nodeId !== undefined
              ? 'spatial:node'
              : anchor.edgeId !== undefined
                ? 'spatial:edge'
                : 'spatial:point',
          )
        } else {
          seen.add(anchor.nodeId !== undefined ? 'text:node' : 'text:body')
        }
        return annotationAnchorSchema.safeParse(anchor).success
      }),
      { numRuns: 300 },
    )
    for (const kind of ANNOTATION_ANCHOR_KINDS) expect(seen).toContain(kind)
    expect([...seen].sort()).toEqual([
      'spatial',
      'spatial:edge',
      'spatial:node',
      'spatial:point',
      'text',
      'text:body',
      'text:node',
    ])
  })
})

describe('canvasCommentFromThread', () => {
  const opened = (anchor: AnnotationAnchor): CommentThread => ({
    id: 't1',
    anchor,
    status: 'open',
    messages: [{ id: 'm1', body: 'look here', createdAt: '2026-09-02T00:00:00.000Z' }],
  })
  const nodes = new Map([['n1', { id: 'n1', x: 100, y: 200, width: 50 }]])
  const nodeById = (id: string) => nodes.get(id)

  it('projects a spatial anchor with its node or edge reference', () => {
    expect(
      canvasCommentFromThread(opened({ kind: 'spatial', nodeId: 'n1', x: 1, y: 2 })),
    ).toMatchObject({ id: 't1', x: 1, y: 2, targetNodeId: 'n1', text: 'look here' })
    expect(
      canvasCommentFromThread(opened({ kind: 'spatial', edgeId: 'e1', x: 1, y: 2 })),
    ).toMatchObject({ targetEdgeId: 'e1' })
  })

  it("projects a passage of a node's text as a comment on that node, at its corner", () => {
    const projected = canvasCommentFromThread(
      opened({ kind: 'text', nodeId: 'n1', quote: { exact: 'here' }, start: 5, end: 9 }),
      nodeById,
    )
    expect(projected).toMatchObject({ x: 150, y: 200, targetNodeId: 'n1' })
  })

  it('projects nothing for a passage whose node is gone, or a passage of a note', () => {
    const gone = opened({ kind: 'text', nodeId: 'n-gone', quote: { exact: 'x' }, start: 0, end: 1 })
    expect(canvasCommentFromThread(gone, nodeById)).toBeUndefined()
    // Without a lookup a node passage is unplaceable too — not a wrong place.
    expect(
      canvasCommentFromThread(
        opened({ kind: 'text', nodeId: 'n1', quote: { exact: 'x' }, start: 0, end: 1 }),
      ),
    ).toBeUndefined()
    expect(
      canvasCommentFromThread(
        opened({ kind: 'text', quote: { exact: 'x' }, start: 0, end: 1 }),
        nodeById,
      ),
    ).toBeUndefined()
  })

  it('round-trips a flat comment through a thread and back, reference included', () => {
    fc.assert(
      fc.property(annotationAnchorArbitrary, (anchor) => {
        if (anchor.kind !== 'spatial') return true
        const back = canvasCommentFromThread(opened(anchor))
        return (
          back !== undefined &&
          threadFromCanvasComment(back).anchor.kind === 'spatial' &&
          JSON.stringify(threadFromCanvasComment(back).anchor) === JSON.stringify(anchor)
        )
      }),
    )
  })
})
