/**
 * Undo pressed while typed body text is still inside its debounce window.
 *
 * Typed text is already in the session's document, so an undo inside the
 * window commits it as its own step and then takes that step back: the screen,
 * the store and the saved indicator never disagree.
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

  it('takes the typed text back as its own step, leaving it to redo', () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')

    expect(s.session.undo()).toBe(true)

    expect(s.session.getMarkdownBody()).toBe('hello')
    expect(s.session.canUndo()).toBe(false)
    expect(s.session.canRedo()).toBe(true)
    s.session.dispose()
  })

  it('writes the removal and reports saved with the store equal to the screen', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')
    s.session.undo()

    await s.settle()

    expect(s.remoteBody()).toBe('hello')
    expect(s.session.getMarkdownBody()).toBe('hello')
    expect(s.persistence.at(-1)).toBe('saved')
    s.session.dispose()
  })

  it('restores the text locally and remotely on redo', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')
    s.session.undo()
    await s.settle()

    expect(s.session.redo()).toBe(true)
    await s.settle()

    expect(s.session.getMarkdownBody()).toBe('hello world')
    expect(s.remoteBody()).toBe('hello world')
    expect(s.persistence.at(-1)).toBe('saved')
    s.session.dispose()
  })

  it('keeps the store equal to the screen whenever persistence reports saved', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')
    s.session.undo()
    await s.settle()
    expect(s.persistence.at(-1)).toBe('saved')
    expect(s.remoteBody()).toBe(s.session.getMarkdownBody())

    typeIntoBody(s.session, 0, '>')
    s.session.undo()
    s.session.redo()
    await s.settle()
    expect(s.persistence.at(-1)).toBe('saved')
    expect(s.remoteBody()).toBe(s.session.getMarkdownBody())
    s.session.dispose()
  })

  it('keeps the typed text and saves it when redo is pressed over text typed after an undo', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')
    await s.settle()
    s.session.undo()
    await s.settle()
    expect(s.session.canRedo()).toBe(true)

    typeIntoBody(s.session, 5, '!')
    s.session.redo()
    await s.settle()

    expect(s.session.getMarkdownBody()).toBe('hello!')
    expect(s.session.canRedo()).toBe(false)
    expect(s.remoteBody()).toBe('hello!')
    expect(s.persistence.at(-1)).toBe('saved')
    s.session.dispose()
  })

  it('writes the typed text when the session is disposed after an undo that had nothing queued', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')
    s.session.undo()
    s.session.redo()

    s.session.dispose()
    await s.settle(10)

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

    it('removes only the pending text and leaves the committed step on the stack', async () => {
      const s = await withCommittedEdit()
      expect(s.pushed).toHaveLength(1)

      expect(s.session.undo()).toBe(true)
      await s.settle()

      expect(s.session.getMarkdownBody()).toBe('hello1')
      expect(s.session.canUndo()).toBe(true)
      expect(s.session.canRedo()).toBe(true)
      expect(s.remoteBody()).toBe('hello1')
      expect(s.persistence.at(-1)).toBe('saved')

      expect(s.session.redo()).toBe(true)
      await s.settle()
      expect(s.session.getMarkdownBody()).toBe('hello12')
      expect(s.remoteBody()).toBe('hello12')
      s.session.dispose()
    })
  })
})
