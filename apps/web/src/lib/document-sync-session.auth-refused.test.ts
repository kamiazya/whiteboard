/**
 * A refused credential, by the request it was refused on. A refused stream
 * or subscription stops this document following the keeper: live sync is
 * off. A refused PUSH does not — writing needs a scope reading does not, so
 * the stream may still follow the document — and what the person needs to
 * know is that their changes are not being kept, which the write path
 * already says.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  editAndPush,
  flushMicrotasks,
  openTestSession,
  snapshotOf,
} from '../test-utils/document-sync-session.js'
import { sessionHealthOf } from './connection-state.js'
import type { EditorCommand } from './spatial/commands.js'

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 40, text: 'A' })],
  edges: [],
}

afterEach(() => {
  vi.useRealTimers()
})

/** A session over a backend whose pushes never settle, as a refused one's do not. */
function openSession() {
  let authErrors = 0
  const { session, handlers, statuses, persistenceStates } = openTestSession({
    push: () => new Promise<void>(() => {}),
    snapshot: snapshotOf(canvas),
    deps: {
      getOptions: () => ({
        onAuthError: () => {
          authErrors += 1
        },
      }),
    },
  })
  return {
    session,
    handlers,
    authErrors: () => authErrors,
    // What a daemon-kept page derives from the same three facts.
    health: () =>
      sessionHealthOf(
        authErrors > 0,
        statuses.at(-1) ?? 'idle',
        persistenceStates.at(-1) ?? { kind: 'saved', lastSavedAt: null },
      ),
  }
}

const MOVE: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }

describe('a refused credential', () => {
  it('reads a refused push as changes not saved, not as live sync off', async () => {
    vi.useFakeTimers()
    const s = openSession()
    await editAndPush(s.session, canvas, MOVE)
    // The order a refused push produces with the stream still open: the
    // refusal, then the write that did not land.
    s.handlers().onAuthError?.('push')
    s.handlers().onError?.('storage-failure')
    await flushMicrotasks()

    expect(s.authErrors()).toBe(0)
    expect(s.health()).toBe('write-failed')
    s.session.dispose()
  })

  it.each([
    'stream',
    'subscribe',
  ] as const)('reads a refused %s as live sync off', async (cause) => {
    vi.useFakeTimers()
    const s = openSession()
    await editAndPush(s.session, canvas, MOVE)
    s.handlers().onAuthError?.(cause)
    await flushMicrotasks()

    expect(s.authErrors()).toBe(1)
    expect(s.health()).toBe('sync-off')
    s.session.dispose()
  })
})
