/**
 * A remote update arriving while typed body text is still inside its debounce
 * window. What the editing tab sees and what it writes:
 *
 * - the body reads both the typed and the remote text as soon as the import
 *   returns;
 * - the import commits the typed text first, so the tab is told of TWO changes
 *   (its own edit's commit, then the import), the typed text is its own undo
 *   step at once, and the window's timer has nothing left to commit;
 * - what is pushed is the typed text alone, once — the remote update is not
 *   echoed back — and a replica given the pushes and the remote update holds
 *   what the tab holds.
 */

import { afterAllFloor, fc, withDefaults } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushMicrotasks,
  markdownSnapshotOf,
  openTestSession,
  typeIntoBody,
} from '../test-utils/document-sync-session.js'
import { fcTest } from '../test-utils/fast-check.js'
import { COMMIT_DEBOUNCE_MS } from './document-sync-session.js'
import { DOCUMENT_SYNC_CHANGED_EVENT } from './document-sync-types.js'

const SNAPSHOT = markdownSnapshotOf('hello')

/** A peer that opened the same snapshot and inserted `text` at `at`. */
function remoteInsert(at: number, text: string): Uint8Array {
  const peer = new LoroDoc()
  peer.import(SNAPSHOT)
  peer.getText('body').insert(at, text)
  peer.commit()
  return peer.export({ mode: 'update' })
}

function bodyOf(...updates: readonly Uint8Array[]): string {
  const replica = new LoroDoc()
  replica.import(SNAPSHOT)
  for (const update of updates) replica.import(update)
  return replica.getText('body').toString()
}

function openedSession() {
  const pushed: Uint8Array[] = []
  const log: string[] = []
  const s = openTestSession({
    snapshot: SNAPSHOT,
    push: (update) => {
      pushed.push(update)
      return Promise.resolve()
    },
    deps: {
      dispatchIdentityEvent: (name) => log.push(name),
      onOwnEditContentState: () => log.push('own-edit'),
    },
  })
  s.session.subscribeMarkdownBody(() => log.push(`body:${s.session.getMarkdownBody()}`))
  s.session.subscribe((_canvas, origin) => log.push(`canvas:${origin}`))
  const closeWindow = async () => {
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS)
    await flushMicrotasks()
  }
  return { ...s, pushed, log, closeWindow }
}

describe('a remote update arriving while typed body text is inside its window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the typed and the remote text together as soon as the import returns', () => {
    const s = openedSession()
    typeIntoBody(s.session, 0, '>')

    s.handlers().onRemoteUpdate(remoteInsert(5, ' there'))

    expect(s.session.getMarkdownBody()).toBe('>hello there')
    s.session.dispose()
  })

  it('tells the tab of the typed text then the import, one of each notification apiece', async () => {
    const s = openedSession()
    const opening = s.log.length
    typeIntoBody(s.session, 0, '>')
    s.handlers().onRemoteUpdate(remoteInsert(5, ' there'))
    await flushMicrotasks()

    expect(s.log.slice(opening)).toEqual([
      'own-edit',
      DOCUMENT_SYNC_CHANGED_EVENT,
      'body:>hello there',
      DOCUMENT_SYNC_CHANGED_EVENT,
      'body:>hello there',
      'canvas:external',
    ])

    await s.closeWindow()
    expect(s.log.slice(opening)).toHaveLength(6)
    s.session.dispose()
  })

  it('makes the typed text an undo step at once, which undoes once the window has closed and keeps the remote text', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 0, '>')
    s.handlers().onRemoteUpdate(remoteInsert(5, ' there'))
    await s.closeWindow()

    expect(s.session.canUndo()).toBe(true)
    expect(s.session.undo()).toBe(true)

    expect(s.session.getMarkdownBody()).toBe('hello there')
    expect(s.session.canUndo()).toBe(false)
    s.session.dispose()
  })

  it('answers an undo pressed before the window closes with true and changes nothing, the step still on the stack', () => {
    const s = openedSession()
    typeIntoBody(s.session, 0, '>')
    s.handlers().onRemoteUpdate(remoteInsert(5, ' there'))

    expect(s.session.undo()).toBe(true)

    expect(s.session.getMarkdownBody()).toBe('>hello there')
    expect(s.session.canUndo()).toBe(true)
    s.session.dispose()
  })

  it('pushes the typed text alone, once, and nothing more when the window closes', async () => {
    const s = openedSession()
    typeIntoBody(s.session, 0, '>')
    s.handlers().onRemoteUpdate(remoteInsert(5, ' there'))
    await flushMicrotasks()
    expect(s.pushed).toHaveLength(1)

    await s.closeWindow()

    expect(s.pushed).toHaveLength(1)
    expect(bodyOf(s.pushed[0] as Uint8Array)).toBe('>hello')
  })

  it('leaves a second replica holding what the tab holds once it has the pushes and the remote update', async () => {
    const s = openedSession()
    const remote = remoteInsert(5, ' there')
    typeIntoBody(s.session, 0, '>')
    s.handlers().onRemoteUpdate(remote)
    await s.closeWindow()

    expect(bodyOf(...s.pushed, remote)).toBe(s.session.getMarkdownBody())
    s.session.dispose()
  })

  describe('wherever each side typed', () => {
    const tally = { runs: 0, samePosition: 0 }

    fcTest.prop(
      [fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), fc.boolean(), fc.boolean()],
      withDefaults({ numRuns: 30 }),
    )(
      'a second replica given the pushes and the remote update converges with the tab',
      async (localAt, remoteRaw, sameSpot, closeFirst) => {
        const remoteAt = sameSpot ? localAt : remoteRaw
        tally.runs += 1
        if (remoteAt === localAt) tally.samePosition += 1
        const s = openedSession()
        const remote = remoteInsert(remoteAt, '<r>')
        typeIntoBody(s.session, localAt, '[l]')
        if (closeFirst) await s.closeWindow()
        s.handlers().onRemoteUpdate(remote)
        await s.closeWindow()

        expect(bodyOf(...s.pushed, remote)).toBe(s.session.getMarkdownBody())
        expect(s.session.getMarkdownBody()).toContain('[l]')
        expect(s.session.getMarkdownBody()).toContain('<r>')
        s.session.dispose()
      },
    )

    afterAllFloor(
      ['a second replica given the pushes and the remote update converges with the tab'],
      () => {
        expect(tally.runs).toBeGreaterThanOrEqual(30)
        expect(tally.samePosition).toBeGreaterThan(0)
      },
    )
  })
})
