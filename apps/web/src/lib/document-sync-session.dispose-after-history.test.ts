/**
 * A session torn down in the same task as an undo or redo.
 *
 * A local update reaches the keeper on a later microtask than the call that
 * made it, and a keeper drops a write that arrives after it was let go (the
 * browser's does), so teardown has to wait for every update the session
 * produced, not only those from its debounced commit.
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
  const replica = new LoroDoc()
  replica.import(SNAPSHOT)
  let disconnected = false
  const s = openTestSession({
    snapshot: SNAPSHOT,
    push: (update) => {
      if (!disconnected) replica.import(update)
      return Promise.resolve()
    },
    disconnect: () => {
      disconnected = true
    },
  })
  const hasDisconnected = (): boolean => disconnected
  const stored = (): string => replica.getText('body').toString()
  const settle = async () => {
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS * 3)
    await flushMicrotasks()
  }
  return { ...s, stored, settle, hasDisconnected }
}

describe('disposing in the task that undid or redid', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('stores the body the session ended on after an undo of text typed in the window', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')
    s.session.undo()
    const shown = s.session.getMarkdownBody()
    s.session.dispose()
    await s.settle()

    expect(shown).toBe('hello')
    expect(s.stored()).toBe(shown)
  })

  it('stores the text after an undo then a redo of it', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, ' world')
    s.session.undo()
    s.session.redo()
    const shown = s.session.getMarkdownBody()
    s.session.dispose()
    await s.settle()

    expect(shown).toBe('hello world')
    expect(s.stored()).toBe(shown)
  })

  it('stores the body after an undo of an already committed step', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, '1')
    await s.settle()
    expect(s.stored()).toBe('hello1')

    s.session.undo()
    const shown = s.session.getMarkdownBody()
    s.session.dispose()
    await s.settle()

    expect(shown).toBe('hello')
    expect(s.stored()).toBe(shown)
  })

  it('stores the body after a redo of an already committed step', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, '1')
    await s.settle()
    s.session.undo()
    await s.settle()
    expect(s.stored()).toBe('hello')

    s.session.redo()
    const shown = s.session.getMarkdownBody()
    s.session.dispose()
    await s.settle()

    expect(shown).toBe('hello1')
    expect(s.stored()).toBe(shown)
  })

  it('lets the keeper go at once when every push has already been issued', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 5, '1')
    await s.settle()
    s.session.undo()
    await s.settle()

    s.session.dispose()

    expect(s.hasDisconnected()).toBe(true)
  })
})
