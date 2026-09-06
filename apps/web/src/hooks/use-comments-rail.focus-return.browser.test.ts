/**
 * Where the reader came from, so the rail has somewhere to send them back.
 *
 * The rail is opened from four different surfaces — a gutter marker, a
 * preview marker, the editor toolbar, a canvas pin — and each of them leaves
 * focus somewhere different. Rather than teach every caller to name its own
 * return target, the two entry points that OPEN the rail remember whatever
 * held focus at the moment they were called, which is the surface the press
 * came from by construction.
 *
 * Deliberately not `selectThread`: choosing another conversation from inside
 * the rail is not an entry, and re-capturing there would make the way out a
 * row of the list the reader is standing in.
 *
 * A real browser, because every claim here is about `document.activeElement`
 * and jsdom's focus model is not the reader's.
 */
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CommentsRailWrite, useCommentsRail } from './use-comments-rail.js'

const WRITE: CommentsRailWrite = {
  createThread: vi.fn(),
  replyToThread: vi.fn(),
  setThreadStatus: vi.fn(),
  editMessage: vi.fn(),
}

const THREAD: CommentThread = {
  id: 't-1',
  anchor: { kind: 'spatial', x: 10, y: 20 },
  status: 'open',
  messages: [{ id: 'm1', body: 'is this still true?' }],
}

function railFor(threads: readonly CommentThread[] = [THREAD]) {
  return renderHook(() =>
    useCommentsRail({
      scopeKey: 'doc-1',
      open: true,
      onOpenChange: () => {},
      threads,
      documentKind: 'markdown',
      markdownBody: 'Ship the report on Friday.',
      canvas: null,
      write: WRITE,
    }),
  )
}

let origin: HTMLButtonElement
let elsewhere: HTMLButtonElement

beforeEach(() => {
  origin = document.createElement('button')
  elsewhere = document.createElement('button')
  document.body.append(origin, elsewhere)
})

afterEach(() => {
  origin.remove()
  elsewhere.remove()
})

describe('the way back out of the rail', () => {
  it('remembers the surface a reveal was pressed from, and returns focus there', () => {
    const { result } = railFor()
    origin.focus()

    act(() => result.current.revealThread('t-1'))
    // Whatever the rail does with focus next, the press came from here.
    elsewhere.focus()
    expect(document.activeElement).toBe(elsewhere)

    act(() => result.current.returnFocus())
    expect(document.activeElement).toBe(origin)
  })

  it('remembers it for a compose too — the passage was selected on that surface', () => {
    const { result } = railFor([])
    origin.focus()

    act(() => result.current.composeThread({ kind: 'document' }))
    elsewhere.focus()

    act(() => result.current.returnFocus())
    expect(document.activeElement).toBe(origin)
  })

  it('does not re-aim at a row the reader picked from inside the rail', () => {
    const { result } = railFor()
    origin.focus()
    act(() => result.current.revealThread('t-1'))

    // Standing in the rail now, on some row of the list.
    elsewhere.focus()
    act(() => result.current.selectThread('t-1'))

    act(() => result.current.returnFocus())
    expect(document.activeElement).toBe(origin)
  })

  it('stays put when the surface it remembered is gone, rather than jumping to the body', () => {
    // The outcome, not the mechanism: the platform already declines to focus
    // a detached node, so this pins the behaviour against a later `return
    // focus SOMEWHERE` fallback rather than against a line of this hook.
    const { result } = railFor()
    origin.focus()
    act(() => result.current.revealThread('t-1'))

    // The editor remounted, or the document was switched under the rail.
    origin.remove()
    elsewhere.focus()

    act(() => result.current.returnFocus())
    expect(document.activeElement).toBe(elsewhere)
  })

  it('is inert before any conversation has been opened', () => {
    const { result } = railFor()
    elsewhere.focus()
    act(() => result.current.returnFocus())
    expect(document.activeElement).toBe(elsewhere)
  })
})
