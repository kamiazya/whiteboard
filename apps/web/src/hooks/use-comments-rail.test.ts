// @vitest-environment jsdom
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CommentsRailWrite } from '../lib/comments-rail-write.js'
import { useCommentsRail } from './use-comments-rail.js'

// The hook builds every write the rail makes and hands the finished value to
// a keeper-specific door. A recording door is the nearest place to see what
// it built: the panel tests above it render the result, and a write that is
// wrong but well-formed renders exactly like a right one.

const thread: CommentThread = {
  id: 't1',
  anchor: { kind: 'spatial', x: 10, y: 20 },
  status: 'resolved',
  messages: [
    { id: 'm1', body: 'first', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'm2', body: 'reply', createdAt: '2026-01-02T00:00:00.000Z' },
  ],
}

function recordingWrite(): CommentsRailWrite {
  return {
    createThread: vi.fn(),
    replyToThread: vi.fn(),
    setThreadStatus: vi.fn(),
    editMessage: vi.fn(),
  }
}

function renderRail(over: Partial<Parameters<typeof useCommentsRail>[0]> = {}) {
  const write = recordingWrite()
  const hook = renderHook(() =>
    useCommentsRail({
      scopeKey: 'doc-a',
      open: true,
      onOpenChange: () => {},
      threads: [thread],
      documentKind: 'spatial',
      markdownBody: null,
      canvas: { nodes: [], edges: [] },
      write,
      ...over,
    }),
  )
  return { write, hook }
}

describe('useCommentsRail writes', () => {
  it('Reopen writes the conversation open, Resolve writes it resolved', () => {
    const { write, hook } = renderRail()
    act(() => hook.result.current.resolve('t1', false))
    act(() => hook.result.current.resolve('t1', true))
    expect(vi.mocked(write.setThreadStatus).mock.calls).toEqual([
      ['t1', 'open'],
      ['t1', 'resolved'],
    ])
  })

  // Only the opening message is drawn on the canvas, so the flag is what
  // decides whether the pin's text follows the edit.
  it('an edit says whether it rewrote the opening message', () => {
    const { write, hook } = renderRail()
    act(() => hook.result.current.editMessage('t1', 'm1', 'first!'))
    act(() => hook.result.current.editMessage('t1', 'm2', 'reply!'))
    expect(vi.mocked(write.editMessage).mock.calls.map((call) => call[2])).toEqual([true, false])
  })

  it('an edit keeps the original stamp and adds an edit stamp', () => {
    const { write, hook } = renderRail()
    act(() => hook.result.current.editMessage('t1', 'm2', 'reply!'))
    const message = vi.mocked(write.editMessage).mock.calls[0]?.[1]
    expect(message).toMatchObject({
      id: 'm2',
      body: 'reply!',
      createdAt: '2026-01-02T00:00:00.000Z',
    })
    expect(Number.isNaN(Date.parse(message?.editedAt ?? ''))).toBe(false)
  })
})

describe('useCommentsRail draft and selection', () => {
  it('posting a draft closes it and expands the conversation it opened', () => {
    const { write, hook } = renderRail()
    act(() => hook.result.current.composeThread({ kind: 'spatial', x: 1, y: 2 }))
    expect(hook.result.current.composeAnchor).not.toBeNull()
    act(() => hook.result.current.createThread({ kind: 'spatial', x: 1, y: 2 }, 'hello'))
    const created = vi.mocked(write.createThread).mock.calls[0]?.[0]
    expect(created?.messages[0]?.body).toBe('hello')
    expect(hook.result.current.composeAnchor).toBeNull()
    expect(hook.result.current.selectedThreadId).toBe(created?.id)
  })

  it('starting a draft collapses the conversation that was open', () => {
    const { hook } = renderRail()
    act(() => hook.result.current.selectThread('t1'))
    expect(hook.result.current.selectedThreadId).toBe('t1')
    act(() => hook.result.current.composeThread({ kind: 'spatial', x: 1, y: 2 }))
    expect(hook.result.current.selectedThreadId).toBeNull()
  })
})

describe('useCommentsRail anchor resolver', () => {
  it('judges anchors on a spatial document', () => {
    const { hook } = renderRail()
    expect(hook.result.current.resolveAnchor).toBeTypeOf('function')
  })

  // "Cannot tell" renders as neither placed nor orphaned; a resolver built
  // before the kind is known would mark every conversation one or the other.
  it('offers no resolver while the document kind is unknown', () => {
    const { hook } = renderRail({ documentKind: null })
    expect(hook.result.current.resolveAnchor).toBeUndefined()
  })
})
