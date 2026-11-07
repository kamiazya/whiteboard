// @vitest-environment node

import { type CommentThread, canvasCommentsOf } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { threadsAfterCommand } from './thread-commands.js'

// The conversations a command leaves, which the sync session publishes at
// once so a pin moves, mutes or appears before the debounced commit. Pinned
// through the pin a person sees (`canvasCommentsOf`) where that is the claim,
// and in the order the threads plane stores, which decides bubble placement.
describe('threadsAfterCommand', () => {
  const NODE = textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 40, text: 'n' })
  const open = (
    id: string,
    anchor: CommentThread['anchor'] = { kind: 'spatial', x: 10, y: 20 },
  ): CommentThread => ({
    id,
    anchor,
    status: 'open',
    messages: [{ id: `${id}-m1`, body: 'opening', createdAt: '2026-01-01T00:00:00.000Z' }],
  })
  const pinOf = (threads: readonly CommentThread[], id: string) =>
    canvasCommentsOf(threads, [NODE]).find((comment) => comment.id === id)

  it('opens a thread in the stored order, by id, and its pin is drawn', () => {
    const threads = [open('a'), open('c')]
    const next = threadsAfterCommand(threads, { kind: 'create-thread', thread: open('b') })
    expect(next.map((thread) => thread.id)).toEqual(['a', 'b', 'c'])
    expect(pinOf(next, 'b')).toMatchObject({ x: 10, y: 20, text: 'opening' })
  })

  it('opening an id already held is a no-op answering the same array', () => {
    const threads = [open('a')]
    expect(threadsAfterCommand(threads, { kind: 'create-thread', thread: open('a') })).toBe(threads)
  })

  it('resolving mutes the pin, reopening clears it, and an unknown id is a no-op', () => {
    const threads = [open('t1')]
    const resolved = threadsAfterCommand(threads, {
      kind: 'set-thread-status',
      threadId: 't1',
      status: 'resolved',
    })
    expect(pinOf(resolved, 't1')?.resolved).toBe(true)
    const reopened = threadsAfterCommand(resolved, {
      kind: 'set-thread-status',
      threadId: 't1',
      status: 'open',
    })
    expect(pinOf(reopened, 't1')?.resolved).toBeUndefined()
    const ghost = { kind: 'set-thread-status', threadId: 'ghost', status: 'open' } as const
    expect(threadsAfterCommand(threads, ghost)).toBe(threads)
  })

  it('a reply appends in message order and leaves the drawn opening text alone', () => {
    const next = threadsAfterCommand([open('t1')], {
      kind: 'reply-to-thread',
      threadId: 't1',
      message: { id: 'r1', body: 'a reply', createdAt: '2026-01-02T00:00:00.000Z' },
    })
    expect(next[0]?.messages.map((message) => message.body)).toEqual(['opening', 'a reply'])
    expect(pinOf(next, 't1')?.text).toBe('opening')
  })

  it('editing the opening message rewrites the drawn text', () => {
    const next = threadsAfterCommand([open('t1')], {
      kind: 'edit-thread-message',
      threadId: 't1',
      message: { id: 't1-m1', body: 'rewritten', createdAt: '2026-01-01T00:00:00.000Z' },
      opening: true,
    })
    expect(next[0]?.messages).toHaveLength(1)
    expect(pinOf(next, 't1')?.text).toBe('rewritten')
  })

  it('moving a point pin moves it; a region keeps its anchor and answers the same array', () => {
    const moved = threadsAfterCommand([open('t1')], {
      kind: 'move-thread',
      threadId: 't1',
      x: 300,
      y: -40,
    })
    expect(pinOf(moved, 't1')).toMatchObject({ x: 300, y: -40 })
    const regions = [open('r', { kind: 'spatial', x: 0, y: 0, width: 50, height: 50 })]
    expect(threadsAfterCommand(regions, { kind: 'move-thread', threadId: 'r', x: 9, y: 9 })).toBe(
      regions,
    )
  })

  it('a pin dropped on a node or an edge is about it; on nothing, a point', () => {
    const onNode = threadsAfterCommand([open('t1')], {
      kind: 'move-thread',
      threadId: 't1',
      x: 5,
      y: 6,
      nodeId: 'n1',
    })
    expect(onNode[0]?.anchor).toEqual({ kind: 'spatial', x: 5, y: 6, nodeId: 'n1' })
    const onEdge = threadsAfterCommand(onNode, {
      kind: 'move-thread',
      threadId: 't1',
      x: 7,
      y: 8,
      edgeId: 'e1',
    })
    expect(onEdge[0]?.anchor).toEqual({ kind: 'spatial', x: 7, y: 8, edgeId: 'e1' })
    const offIt = threadsAfterCommand(onEdge, { kind: 'move-thread', threadId: 't1', x: 9, y: 9 })
    expect(offIt[0]?.anchor).toEqual({ kind: 'spatial', x: 9, y: 9 })
  })

  it('reaches inside a batch, and a canvas command answers the same array', () => {
    const threads = [open('t1')]
    const next = threadsAfterCommand(threads, {
      kind: 'batch',
      commands: [{ kind: 'set-thread-status', threadId: 't1', status: 'resolved' }],
    })
    expect(next[0]?.status).toBe('resolved')
    expect(threadsAfterCommand(threads, { kind: 'move-node', id: 'n1', x: 1, y: 1 })).toBe(threads)
  })
})
