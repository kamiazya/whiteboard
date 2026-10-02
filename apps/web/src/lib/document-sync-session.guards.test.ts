/**
 * The session's quieter guards: what a hidden tab flushes, what a replaced or
 * disposed session refuses to act on, and the timer its teardown must not
 * leave behind. Each is a line whose absence changes nothing a happy-path
 * test can see.
 */
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import { createDocumentSyncSession, createGenerationCounters } from './document-sync-session.js'
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

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function openSession(checkpoints?: { signal: () => void; flush: () => void }) {
  let handlers: DocumentBackendHandlers | null = null
  const backend = {
    connect(h: DocumentBackendHandlers) {
      handlers = h
      h.onConnected()
    },
    disconnect() {},
    pushLocalUpdate: () => Promise.resolve(),
    sendClientReady() {},
  } as unknown as DocumentBackend
  const persistence: BrowserPersistenceState['kind'][] = []
  const onStatusChange = vi.fn()
  const session = createDocumentSyncSession(backend, {
    getOptions: () => ({}),
    onStatusChange,
    onBackendError: () => {},
    onRestoreChange: () => {},
    dispatchIdentityEvent: () => {},
    generations: createGenerationCounters(),
    onPersistenceChange: (state) => persistence.push(state.kind),
    checkpoints,
  })
  session.connect()
  handlers!.onSnapshot(snapshotOf(canvas))
  return { session, persistence, onStatusChange, handlers: handlers! as DocumentBackendHandlers }
}

function withVisibility(state: DocumentVisibilityState): () => void {
  const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  return () => {
    delete (document as { visibilityState?: unknown }).visibilityState
    if (original) Object.defineProperty(Document.prototype, 'visibilityState', original)
  }
}

describe('the checkpoint flush when a tab is hidden', () => {
  // A backgrounded mobile tab may never fire `pagehide`, so `hidden` is the
  // last signal the checkpoint trigger is certain to get.
  it('flushes once when the tab becomes hidden', () => {
    const checkpoints = { signal: vi.fn(), flush: vi.fn() }
    const restore = withVisibility('hidden')
    const s = openSession(checkpoints)
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      expect(checkpoints.flush).toHaveBeenCalledTimes(1)
    } finally {
      restore()
      s.session.dispose()
    }
  })

  it('does not flush when the tab becomes visible again', () => {
    const checkpoints = { signal: vi.fn(), flush: vi.fn() }
    const restore = withVisibility('visible')
    const s = openSession(checkpoints)
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      expect(checkpoints.flush).not.toHaveBeenCalled()
    } finally {
      restore()
      s.session.dispose()
    }
  })
})

describe('a session that has been replaced or disposed', () => {
  // A snapshot replaces the session's document, and the editor remounts on the
  // new binding. A write the old binding still reports is ops in a document the
  // session no longer holds: marking the session edited for it would show
  // "unsaved" for a commit that will never happen.
  it('ignores an edit reported by a body binding of a document a snapshot replaced', () => {
    const s = openSession()
    const stale = s.session.getBodyBinding()!
    s.handlers.onSnapshot(snapshotOf(canvas))
    const current = s.session.getBodyBinding()!
    expect(current).not.toBe(stale)

    stale.commit()
    expect(s.persistence).toEqual([])

    // The control: the same call on the live binding is what marks an edit, so
    // the empty list above means the guard held rather than the signal is dead.
    current.commit()
    expect(s.persistence).toEqual(['pending'])
    s.session.dispose()
  })

  it('does not report a landed write after it was disposed', () => {
    const s = openSession()
    s.session.dispose()
    const reported = s.onStatusChange.mock.calls.length

    s.handlers.onWritesLanded?.()
    expect(s.onStatusChange).toHaveBeenCalledTimes(reported)
    expect(s.persistence).toEqual([])
  })
})

describe('tearing down a session with a commit still queued', () => {
  // The drain waits on the commit chain with a timeout as a backstop. When the
  // chain wins, that timeout must be cancelled, or every canvas switch leaves a
  // two-second timer behind it.
  it('leaves no timer behind once the queued commit has drained', async () => {
    const s = openSession()
    const edit: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    s.session.onChange(applyCommand(canvas, edit), edit)
    s.session.dispose()
    await flushMicrotasks()
    expect(vi.getTimerCount()).toBe(0)
  })
})
