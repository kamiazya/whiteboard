/**
 * A refused credential, by the request it was refused on. A refused stream
 * or subscription stops this document following the keeper: live sync is
 * off. A refused PUSH does not — writing needs a scope reading does not, so
 * the stream may still follow the document — and what the person needs to
 * know is that their changes are not being kept, which the write path
 * already says.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import { sessionHealthOf } from './connection-state.js'
import { createDocumentSyncSession, createGenerationCounters } from './document-sync-session.js'
import type { SyncStatus } from './document-sync-types.js'
import { applyCommand, type EditorCommand } from './spatial/commands.js'

const canvas: SpatialCanvas = {
  nodes: [textNode({ id: 'n-a', x: 0, y: 0, width: 100, height: 40, text: 'A' })],
  edges: [],
}

function snapshotOf(value: SpatialCanvas): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, value)
  return doc.export({ mode: 'snapshot' })
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

/** A session over a backend whose pushes never settle, as a refused one's do not. */
function openSession() {
  let handlers: DocumentBackendHandlers | null = null
  const backend = {
    connect(h: DocumentBackendHandlers) {
      handlers = h
      h.onConnected()
    },
    disconnect() {},
    pushLocalUpdate: () => new Promise<void>(() => {}),
    sendClientReady() {},
  } as unknown as DocumentBackend
  const persistence: BrowserPersistenceState[] = []
  const statuses: SyncStatus[] = []
  let authErrors = 0
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({
      onAuthError: () => {
        authErrors += 1
      },
    }),
    onStatusChange: (status) => statuses.push(status),
    onBackendError: () => {},
    onRestoreChange: () => {},
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
    onPersistenceChange: (state) => persistence.push(state),
  })
  session.connect()
  handlers!.onSnapshot(snapshotOf(canvas))
  return {
    session,
    handlers: () => handlers!,
    authErrors: () => authErrors,
    // What a daemon-kept page derives from the same three facts.
    health: () =>
      sessionHealthOf(
        authErrors > 0,
        statuses.at(-1) ?? 'idle',
        persistence.at(-1) ?? { kind: 'saved', lastSavedAt: null },
      ),
  }
}

async function editAndPush(session: ReturnType<typeof openSession>['session']) {
  const edit: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
  session.onChange(applyCommand(canvas, edit), edit)
  await vi.advanceTimersByTimeAsync(300)
  await flushMicrotasks()
}

describe('a refused credential', () => {
  it('reads a refused push as changes not saved, not as live sync off', async () => {
    vi.useFakeTimers()
    const s = openSession()
    await editAndPush(s.session)
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
    await editAndPush(s.session)
    s.handlers().onAuthError?.(cause)
    await flushMicrotasks()

    expect(s.authErrors()).toBe(1)
    expect(s.health()).toBe('sync-off')
    s.session.dispose()
  })
})
