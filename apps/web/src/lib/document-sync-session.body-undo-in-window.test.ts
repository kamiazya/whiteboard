/**
 * Undo pressed while typed body text is still inside its debounce window.
 *
 * What the person observes today: the press is answered true, the typed text
 * stays in the body, and the undo stack is untouched — the press cancels the
 * window's timer rather than taking the text back. The text is in the session's
 * document but written nowhere until something else commits the document.
 */

import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushMicrotasks,
  markdownSnapshotOf,
  openTestSession,
  typeIntoBody,
} from '../test-utils/document-sync-session.js'
import { COMMIT_DEBOUNCE_MS } from './document-sync-session.js'

const SNAPSHOT = markdownSnapshotOf('hello')

function openedSession() {
  const pushed: Uint8Array[] = []
  const s = openTestSession({
    snapshot: SNAPSHOT,
    push: (update) => {
      pushed.push(update)
      return Promise.resolve()
    },
  })
  /** What a second replica holds after being given the opening snapshot and every push so far. */
  const remoteBody = (): string => {
    const replica = new LoroDoc()
    replica.import(SNAPSHOT)
    for (const update of pushed) replica.import(update)
    return replica.getText('body').toString()
  }
  const settle = async (ms = COMMIT_DEBOUNCE_MS * 3) => {
    await vi.advanceTimersByTimeAsync(ms)
    await flushMicrotasks()
  }
  return { ...s, pushed, remoteBody, settle }
}

describe('undo while typed body text is inside its debounce window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers true and leaves the typed text in the body with nothing to undo or redo', () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')

    expect(s.session.undo()).toBe(true)

    expect(s.session.getMarkdownBody()).toBe('hello world')
    expect(s.session.canUndo()).toBe(false)
    expect(s.session.canRedo()).toBe(false)
    s.session.dispose()
  })

  it('writes nothing when the window elapses, yet reports the document saved', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')
    s.session.undo()

    await s.settle()

    expect(s.pushed).toHaveLength(0)
    expect(s.remoteBody()).toBe('hello')
    expect(s.session.getMarkdownBody()).toBe('hello world')
    expect(s.persistence.at(-1)).toBe('saved')
    s.session.dispose()
  })

  it('writes the kept text with the next edit as one update, and one undo takes both back', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')
    s.session.undo()
    await s.settle()

    typeIntoBody(s.session, 0, '>')
    await s.settle()

    expect(s.pushed).toHaveLength(1)
    expect(s.remoteBody()).toBe('>hello world')
    expect(s.session.canUndo()).toBe(true)

    expect(s.session.undo()).toBe(true)
    expect(s.session.getMarkdownBody()).toBe('hello')
    expect(s.session.canUndo()).toBe(false)
    expect(s.session.canRedo()).toBe(true)

    expect(s.session.redo()).toBe(true)
    expect(s.session.getMarkdownBody()).toBe('>hello world')
    expect(s.session.canRedo()).toBe(false)
    s.session.dispose()
  })

  it('writes the kept text when the session is disposed', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')
    s.session.undo()

    s.session.dispose()
    await s.settle(10)

    expect(s.pushed).toHaveLength(1)
    expect(s.remoteBody()).toBe('hello world')
  })

  describe('over an earlier committed edit', () => {
    async function withCommittedEdit() {
      const s = openedSession()
      typeIntoBody(s.session, 5, '1')
      await s.settle()
      typeIntoBody(s.session, 6, '2')
      return s
    }

    it('leaves the committed step on the stack and the in-window text in the body', async () => {
      const s = await withCommittedEdit()
      expect(s.pushed).toHaveLength(1)

      expect(s.session.undo()).toBe(true)

      expect(s.session.getMarkdownBody()).toBe('hello12')
      expect(s.session.canUndo()).toBe(true)
      expect(s.session.canRedo()).toBe(false)
      s.session.dispose()
    })

    it('takes back the in-window text as its own step on the next undo, writing it and its removal', async () => {
      const s = await withCommittedEdit()
      s.session.undo()

      expect(s.session.undo()).toBe(true)
      await s.settle()

      expect(s.session.getMarkdownBody()).toBe('hello1')
      expect(s.session.canUndo()).toBe(true)
      expect(s.session.canRedo()).toBe(true)
      // The kept text is committed by the second undo, then removed.
      expect(s.pushed).toHaveLength(3)
      expect(s.remoteBody()).toBe('hello1')

      expect(s.session.redo()).toBe(true)
      await s.settle()
      expect(s.session.getMarkdownBody()).toBe('hello12')
      expect(s.remoteBody()).toBe('hello12')
      s.session.dispose()
    })
  })
})
