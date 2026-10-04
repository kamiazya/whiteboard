/**
 * `restore_started` locks the editor and only `restore_complete` releases it,
 * and the SSE stream does not replay either frame. A connection that drops
 * between the two would leave the editor frozen for the rest of the page's
 * life, so the stream coming back is what releases it: a live stream again is
 * the first moment this client can trust that nothing it is waiting on was
 * lost, and the full state it re-sends is what the server merges.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDocumentSyncSession, createGenerationCounters } from './document-sync-session.js'

function setup() {
  let handlers: DocumentBackendHandlers | null = null
  const backend = {
    connect(h: DocumentBackendHandlers) {
      handlers = h
    },
    disconnect() {},
    pushLocalUpdate: () => Promise.resolve(),
    sendClientReady() {},
  } as unknown as DocumentBackend
  const restore: Array<[boolean, string | null]> = []
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange: () => {},
    onBackendError: () => {},
    onRestoreChange: (inProgress, label) => restore.push([inProgress, label]),
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
  })
  session.connect()
  return { handlers: () => handlers!, restore, session }
}

const lastState = (restore: Array<[boolean, string | null]>) => restore.at(-1)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a restore whose completion frame is lost to a dropped connection', () => {
  it('releases the editor when the stream reconnects', () => {
    const { handlers, restore, session } = setup()
    handlers().onConnected()
    handlers().onRestoreStarted({ label: 'v3' } as never)
    expect(lastState(restore)).toEqual([true, 'v3'])

    handlers().onDisconnected?.()
    expect(lastState(restore)).toEqual([true, 'v3'])
    handlers().onConnected()

    expect(lastState(restore)).toEqual([false, null])
    session.dispose()
  })

  it('stays released when the late completion frame then arrives', () => {
    const { handlers, restore, session } = setup()
    handlers().onConnected()
    handlers().onRestoreStarted({ label: 'v3' } as never)
    handlers().onDisconnected?.()
    handlers().onConnected()
    handlers().onRestoreComplete()

    expect(lastState(restore)).toEqual([false, null])
    expect(restore.filter(([inProgress]) => inProgress)).toHaveLength(1)
    session.dispose()
  })

  it('does not report a restore change for a reconnect with no restore in flight', () => {
    const { handlers, restore, session } = setup()
    handlers().onConnected()
    handlers().onDisconnected?.()
    handlers().onConnected()

    expect(restore).toEqual([])
    session.dispose()
  })

  it('does not release a restore that is still in flight on a connection that never dropped', () => {
    const { handlers, restore, session } = setup()
    handlers().onConnected()
    handlers().onRestoreStarted({ label: 'v3' } as never)
    handlers().onWritesLanded?.()

    expect(lastState(restore)).toEqual([true, 'v3'])
    session.dispose()
  })
})
