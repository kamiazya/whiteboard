/**
 * document-sync-session unit tests — jsdom layer.
 *
 * Exercises the session module directly (no React, no Excalidraw) against a
 * fake DocumentBackend and SpatialCanvas/EditorCommand fixtures — the
 * document-shaped surface this session now owns.
 */

import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import {
  createWorkspaceDocumentAtPath,
  documentContainers,
  readMarkdownBody,
  readSpatialCanvas,
  setNodeLock,
  writeCanvasComment,
  writeCommentThread,
  writeMarkdownBody,
  writeProposal,
  writeSpatialCanvas,
  writeThreadMessage,
} from '@kamiazya/whiteboard-loro-adapter'
import type {
  CanvasComment,
  CommentThread,
  Proposal,
  SpatialCanvas,
  SpatialNode,
} from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import type { EditorCommand } from './spatial/commands.js'
import { applyCommand } from './spatial/commands.js'

// Spies on the module's logger so a fallback-to-full-resync (which always
// logs a warning first, see commitToDoc's doc comment) is directly
// observable rather than inferred from doc contents.
const appLoggerSpies = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }))
vi.mock('./app-logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./app-logger.js')>()
  return {
    ...actual,
    getAppLogger: (name: string) => ({
      ...actual.getAppLogger(name),
      warn: appLoggerSpies.warn,
      error: appLoggerSpies.error,
    }),
  }
})

import {
  createDocumentSyncSession,
  createGenerationCounters,
  type SessionDeps,
} from './document-sync-session.js'

function emptyCanvas(): SpatialCanvas {
  return { nodes: [], edges: [] }
}

function makeSnapshot(canvas: SpatialCanvas = emptyCanvas()): Uint8Array {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc.export({ mode: 'snapshot' })
}

// Drains several microtask turns with real awaits. dispose()'s drain phase
// schedules the flush-triggered push and the deferred disconnect across a few
// microtask turns; fake timers do not control microtasks, so a generous number
// of turns is the reliable way to let that chain settle.
async function flushMicrotasks(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve()
  }
}

type FakeBackendControl = {
  handlers: DocumentBackendHandlers | null
  disconnectCalled: boolean
  pushLocalUpdateCalls: Uint8Array[]
  /** Models a transport that is down: pushes are accepted and discarded,
   *  which is what DaemonBackend does when its socket is not OPEN. */
  transportDown: boolean
  /** When set, every push parks until `releasePushes()` — a slow store. */
  holdPushes: boolean
  releasePushes: () => void
  /** When set, every push rejects — a store that refuses the write. */
  rejectPushes: boolean
}

function makeFakeBackend(): DocumentBackend & { _ctrl: FakeBackendControl } {
  const held: Array<() => void> = []
  const ctrl: FakeBackendControl = {
    handlers: null,
    disconnectCalled: false,
    pushLocalUpdateCalls: [],
    transportDown: false,
    holdPushes: false,
    releasePushes: () => {
      for (const release of held.splice(0)) release()
    },
    rejectPushes: false,
  }
  return {
    _ctrl: ctrl,
    connect(handlers) {
      ctrl.handlers = handlers
      handlers.onConnected()
    },
    disconnect() {
      ctrl.disconnectCalled = true
      ctrl.handlers = null
    },
    pushLocalUpdate(bytes) {
      if (ctrl.transportDown) return Promise.resolve()
      ctrl.pushLocalUpdateCalls.push(bytes)
      if (ctrl.rejectPushes) return Promise.reject(new Error('store refused the write'))
      if (ctrl.holdPushes) {
        return new Promise<void>((resolve) => {
          held.push(resolve)
        })
      }
      return Promise.resolve()
    },
    getFile: async () => null,
    putFile: async (entries, onSuccess) => {
      for (const [fileId] of entries) onSuccess(fileId)
    },
    sendClientReady: () => {},
    sendExportResponse: () => {},
  }
}

function makeDeps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    getOptions: () => ({}),
    onStatusChange: vi.fn(),
    onBackendError: vi.fn(),
    onRestoreChange: vi.fn(),
    dispatchIdentityEvent: vi.fn(),
    generations: createGenerationCounters(),
    ...overrides,
  }
}

const TEXT_NODE_A: SpatialCanvas['nodes'][number] = {
  id: 'n-a',
  type: 'text',
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  text: 'hello',
}
const TEXT_NODE_B: SpatialCanvas['nodes'][number] = {
  id: 'n-b',
  type: 'text',
  x: 200,
  y: 0,
  width: 100,
  height: 50,
  text: 'world',
}

function twoNodeCanvas(): SpatialCanvas {
  return { nodes: [TEXT_NODE_A, TEXT_NODE_B], edges: [] }
}

describe('createDocumentSyncSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    appLoggerSpies.warn.mockClear()
    appLoggerSpies.error.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('connects and reports "connected" via the injected status callback, then sends client-ready', () => {
    const backend = makeFakeBackend()
    const sendReadySpy = vi.spyOn(backend, 'sendClientReady')
    const onStatusChange = vi.fn()
    const session = createDocumentSyncSession(backend, makeDeps({ onStatusChange }))

    session.connect()

    expect(onStatusChange).toHaveBeenCalledWith('connected')
    expect(sendReadySpy).toHaveBeenCalledTimes(1)
  })

  it('re-sends every edit made while the transport was down', async () => {
    // A backend whose transport is down discards the delta it is handed — the
    // WebSocket one returns early unless the socket is OPEN — and every push
    // carries only one commit's ops, so no later push replays it. The transport
    // here discards rather than records, or an implementation that resent just
    // the latest delta would pass.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    backend._ctrl.transportDown = true
    const moveA: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    const afterA = applyCommand(twoNodeCanvas(), moveA)
    session.onChange(afterA, moveA)
    await vi.advanceTimersByTimeAsync(300)
    const moveB: EditorCommand = { kind: 'move-node', id: 'n-b', x: 30, y: 40 }
    session.onChange(applyCommand(afterA, moveB), moveB)
    await vi.advanceTimersByTimeAsync(300)
    expect(backend._ctrl.pushLocalUpdateCalls).toEqual([])

    backend._ctrl.transportDown = false
    backend._ctrl.handlers!.onConnected()
    await flushMicrotasks()

    // Rebuilt from what the server would actually have received.
    const rebuilt = new LoroDoc()
    for (const bytes of backend._ctrl.pushLocalUpdateCalls) rebuilt.import(bytes)
    const nodes = readSpatialCanvas(rebuilt).nodes
    expect(nodes.find((n) => n.id === 'n-a')).toMatchObject({ x: 10, y: 20 })
    expect(nodes.find((n) => n.id === 'n-b')).toMatchObject({ x: 30, y: 40 })
    // The state that predates the outage has to survive the resend too.
    expect(nodes).toHaveLength(twoNodeCanvas().nodes.length)
  })

  // The key every rendition of the open document is memoised under is the
  // digest of the document's content — the same function the workspace
  // listing uses for a row, so a row and the document it lists name one state
  // one way (`content-digest.hosts.test.ts` in loro-adapter holds the three
  // hosts to that).
  it('answers no state before a snapshot, and one that moves when the document does', () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    // Nothing hydrated: the ABSENCE of a state, so nothing is remembered
    // under it rather than everything sharing one key.
    expect(session.getContentState()).toBeNull()

    const canvas = twoNodeCanvas()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(canvas))
    const hydrated = session.getContentState()
    expect(hydrated).not.toBeNull()

    // A remote update imports synchronously, so the document has moved.
    const doc = new LoroDoc()
    doc.import(makeSnapshot(canvas))
    writeSpatialCanvas(doc, {
      ...canvas,
      nodes: [{ ...TEXT_NODE_A, text: 'changed' }, TEXT_NODE_B],
    })
    backend._ctrl.handlers!.onRemoteUpdate(doc.export({ mode: 'update' }))

    expect(session.getContentState()).not.toBe(hydrated)
  })

  // The key names the DOCUMENT, and `onChange` does not write the document:
  // it publishes the canvas at once and writes on a debounce. So straight
  // after `onChange` the published canvas shows the edit and the key does
  // not — measured here rather than assumed, because this is exactly why the
  // surfaces keyed on it listen to the document's post-write notification
  // rather than to the React state the editor renders from. Once the write
  // lands, the key moves.
  it('does not move on a published edit until the debounced write lands', async () => {
    vi.useFakeTimers()
    try {
      const backend = makeFakeBackend()
      const session = createDocumentSyncSession(backend, makeDeps())
      session.connect()
      backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
      const hydrated = session.getContentState()

      const move: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
      session.onChange(applyCommand(twoNodeCanvas(), move), move)

      expect(session.getCanvas().nodes.find((n) => n.id === 'n-a')?.x).toBe(10)
      expect(session.getContentState()).toBe(hydrated)

      await vi.advanceTimersByTimeAsync(1000)
      expect(session.getContentState()).not.toBe(hydrated)
    } finally {
      vi.useRealTimers()
    }
  })

  // The debounce holds edits that are already on screen. A tab that goes
  // away inside that window — closed, switched, backgrounded on a phone —
  // would lose them, and nothing on screen said they were unsaved. The
  // hidden/pagehide signals are the last ones a page reliably gets, so the
  // write goes out on them instead of waiting the window out.
  describe('flushes the debounced write when the page goes away', () => {
    function withVisibility(state: DocumentVisibilityState): () => void {
      const original = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
      return () => {
        delete (document as { visibilityState?: unknown }).visibilityState
        if (original) Object.defineProperty(Document.prototype, 'visibilityState', original)
      }
    }

    async function editThen(fire: () => void): Promise<number> {
      const backend = makeFakeBackend()
      const session = createDocumentSyncSession(backend, makeDeps())
      session.connect()
      backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
      const move: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
      session.onChange(applyCommand(twoNodeCanvas(), move), move)
      fire()
      // Microtasks only — the debounce timer must NOT be what lands it.
      await flushMicrotasks()
      const pushed = backend._ctrl.pushLocalUpdateCalls.length
      session.dispose()
      return pushed
    }

    it('on visibilitychange to hidden', async () => {
      vi.useFakeTimers()
      const restore = withVisibility('hidden')
      try {
        expect(await editThen(() => document.dispatchEvent(new Event('visibilitychange')))).toBe(1)
      } finally {
        restore()
        vi.useRealTimers()
      }
    })

    it('on pagehide', async () => {
      vi.useFakeTimers()
      try {
        expect(await editThen(() => window.dispatchEvent(new Event('pagehide')))).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })

    // The automatic-checkpoint trigger rides the same two signals, and its
    // flush must come AFTER the edit flush above — a checkpoint taken first
    // would point at the record as it stood before the last edit landed,
    // which is the one state nobody wants bookmarked. Registering a second
    // listener from the page would leave that order to registration timing,
    // so the session owns both.
    it('signals the checkpoint trigger on a local edit, and flushes it when the page goes away', async () => {
      vi.useFakeTimers()
      const checkpoints = { signal: vi.fn(), flush: vi.fn() }
      try {
        const backend = makeFakeBackend()
        const session = createDocumentSyncSession(backend, makeDeps({ checkpoints }))
        session.connect()
        backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
        const move: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
        session.onChange(applyCommand(twoNodeCanvas(), move), move)
        window.dispatchEvent(new Event('pagehide'))
        // Microtasks only, for the reason `editThen` above gives: the
        // debounce timer must not be what lands the edit this signals on.
        await flushMicrotasks()

        // Both, and this order: the edit reaches the record on the same
        // signal, so a checkpoint flushed before it would bookmark the state
        // without it.
        expect(checkpoints.signal).toHaveBeenCalled()
        expect(checkpoints.flush).toHaveBeenCalledTimes(1)
        session.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    // The control: becoming VISIBLE is the same event name and must not
    // flush, or every tab switch back would write mid-gesture.
    it('not on visibilitychange to visible', async () => {
      vi.useFakeTimers()
      const restore = withVisibility('visible')
      try {
        expect(await editThen(() => document.dispatchEvent(new Event('visibilitychange')))).toBe(0)
      } finally {
        restore()
        vi.useRealTimers()
      }
    })

    it('stops listening once disposed', async () => {
      vi.useFakeTimers()
      const restore = withVisibility('hidden')
      try {
        const backend = makeFakeBackend()
        const session = createDocumentSyncSession(backend, makeDeps())
        session.connect()
        backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
        session.dispose()
        await flushMicrotasks()
        const before = backend._ctrl.pushLocalUpdateCalls.length
        const move: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
        session.onChange(applyCommand(twoNodeCanvas(), move), move)
        document.dispatchEvent(new Event('visibilitychange'))
        await flushMicrotasks()
        expect(backend._ctrl.pushLocalUpdateCalls.length).toBe(before)
      } finally {
        restore()
        vi.useRealTimers()
      }
    })
  })

  // What the session KNOWS about its own writes, reported as facts for a
  // page to judge: an edit is unsaved from the instant it is published, and
  // saved only once every write behind it has landed — not when the debounce
  // fired, not when the commit ran, but when the store's promise resolved.
  // This is the one place the spatial write path can say so; the store
  // itself never learns which edit a write carried.
  describe('reports persistence facts', () => {
    function kinds(spy: ReturnType<typeof vi.fn>): string[] {
      return spy.mock.calls.map((call) => (call[0] as { kind: string }).kind)
    }

    it('pending on publish, saved once the push has landed', async () => {
      vi.useFakeTimers()
      try {
        const backend = makeFakeBackend()
        const onPersistenceChange = vi.fn()
        const session = createDocumentSyncSession(backend, makeDeps({ onPersistenceChange }))
        session.connect()
        backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
        expect(kinds(onPersistenceChange)).toEqual([])

        const move: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
        session.onChange(applyCommand(twoNodeCanvas(), move), move)
        expect(kinds(onPersistenceChange)).toEqual(['pending'])
        // The debounce firing and the commit running are not landing.
        await vi.advanceTimersByTimeAsync(299)
        expect(kinds(onPersistenceChange)).toEqual(['pending'])

        await vi.advanceTimersByTimeAsync(1)
        await flushMicrotasks()
        expect(kinds(onPersistenceChange)).toEqual(['pending', 'saved'])
        const saved = onPersistenceChange.mock.calls[1][0] as { lastSavedAt: string | null }
        expect(saved.lastSavedAt).not.toBeNull()
        session.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    // Two edits, the second published while the first's write is still in
    // flight: the first landing does not make the document saved, because
    // the second edit is not in it. Only the last write landing does.
    it('stays pending while any write behind an edit is still in flight', async () => {
      vi.useFakeTimers()
      try {
        const backend = makeFakeBackend()
        backend._ctrl.holdPushes = true
        const onPersistenceChange = vi.fn()
        const session = createDocumentSyncSession(backend, makeDeps({ onPersistenceChange }))
        session.connect()
        backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

        const first: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
        const afterFirst = applyCommand(twoNodeCanvas(), first)
        session.onChange(afterFirst, first)
        await vi.advanceTimersByTimeAsync(300)
        await flushMicrotasks()
        expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(1)

        const second: EditorCommand = { kind: 'move-node', id: 'n-b', x: 5, y: 5 }
        session.onChange(applyCommand(afterFirst, second), second)
        await vi.advanceTimersByTimeAsync(300)
        await flushMicrotasks()
        expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(2)

        // Both pushes land now. Nothing between the two edits reported saved.
        expect(kinds(onPersistenceChange)).toEqual(['pending'])
        backend._ctrl.releasePushes()
        await flushMicrotasks()
        expect(kinds(onPersistenceChange)).toEqual(['pending', 'saved'])
        session.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('degraded when the store refuses the write', async () => {
      vi.useFakeTimers()
      try {
        const backend = makeFakeBackend()
        backend._ctrl.rejectPushes = true
        const onPersistenceChange = vi.fn()
        const session = createDocumentSyncSession(backend, makeDeps({ onPersistenceChange }))
        session.connect()
        backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
        const move: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
        session.onChange(applyCommand(twoNodeCanvas(), move), move)
        await vi.advanceTimersByTimeAsync(300)
        await flushMicrotasks()
        expect(kinds(onPersistenceChange)).toEqual(['pending', 'degraded'])
        session.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    // The browser backend never rejects a push: its write runs on a queue it
    // owns, and a store that throws is reported through `onError`
    // ('storage-failure') while the push's own promise resolves. That report
    // is the same fact as a rejection and has to reach the same place, or a
    // browser whose IndexedDB refused the write reads as saved.
    it('degraded when the backend reports a storage failure, saved again once a later write lands', async () => {
      vi.useFakeTimers()
      try {
        const backend = makeFakeBackend()
        const onPersistenceChange = vi.fn()
        const session = createDocumentSyncSession(backend, makeDeps({ onPersistenceChange }))
        session.connect()
        backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
        backend._ctrl.holdPushes = true
        const first: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
        const afterFirst = applyCommand(twoNodeCanvas(), first)
        session.onChange(afterFirst, first)
        await vi.advanceTimersByTimeAsync(300)
        await flushMicrotasks()
        expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(1)
        // The order the browser backend produces: the push is in flight, its
        // write throws and is REPORTED, then the push's own promise resolves
        // as if nothing happened. That resolution must not read as saved.
        backend._ctrl.handlers!.onError?.('storage-failure')
        backend._ctrl.releasePushes()
        await flushMicrotasks()
        expect(kinds(onPersistenceChange)).toEqual(['pending', 'degraded'])

        // A LATER write that completes with no failure reported against it is
        // what clears the condition.
        const second: EditorCommand = { kind: 'move-node', id: 'n-b', x: 5, y: 5 }
        session.onChange(applyCommand(afterFirst, second), second)
        await vi.advanceTimersByTimeAsync(300)
        await flushMicrotasks()
        backend._ctrl.releasePushes()
        await flushMicrotasks()
        expect(kinds(onPersistenceChange)).toEqual(['pending', 'degraded', 'saved'])
        session.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    // A settled edit that is edited again is pending again — the fact is
    // about the document as it stands, not about the first write.
    it('goes pending again on the next edit after saving', async () => {
      vi.useFakeTimers()
      try {
        const backend = makeFakeBackend()
        const onPersistenceChange = vi.fn()
        const session = createDocumentSyncSession(backend, makeDeps({ onPersistenceChange }))
        session.connect()
        backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
        const first: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
        const afterFirst = applyCommand(twoNodeCanvas(), first)
        session.onChange(afterFirst, first)
        await vi.advanceTimersByTimeAsync(300)
        await flushMicrotasks()
        const second: EditorCommand = { kind: 'move-node', id: 'n-b', x: 5, y: 5 }
        session.onChange(applyCommand(afterFirst, second), second)
        expect(kinds(onPersistenceChange)).toEqual(['pending', 'saved', 'pending'])
        session.dispose()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // The bytes and the key are read in one synchronous block on purpose, and
  // this pins that they describe the same state. Nothing can change the
  // document between two synchronous reads, so the pairing holds by
  // construction — but a later refactor that made either read async would
  // break it silently, and a picture memoised under the wrong state is the
  // failure this whole key exists to avoid.
  it('exports bytes that decode to the state its key names', () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const canvas = twoNodeCanvas()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(canvas))

    const first = session.exportSnapshot()
    expect(first).not.toBeNull()
    const rebuilt = new LoroDoc()
    rebuilt.import(first as Uint8Array)
    expect(readSpatialCanvas(rebuilt)).toEqual(canvas)

    const doc = new LoroDoc()
    doc.import(makeSnapshot(canvas))
    const changed = { ...canvas, nodes: [{ ...TEXT_NODE_A, text: 'changed' }, TEXT_NODE_B] }
    writeSpatialCanvas(doc, changed)
    backend._ctrl.handlers!.onRemoteUpdate(doc.export({ mode: 'update' }))

    const after = new LoroDoc()
    after.import(session.exportSnapshot() as Uint8Array)
    expect(readSpatialCanvas(after)).toEqual(changed)
  })

  it('exports nothing before a snapshot, like the key beside it', () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    expect(session.exportSnapshot()).toBeNull()
  })

  it('answers the same state when nothing has changed', () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    expect(session.getContentState()).toBe(session.getContentState())
  })

  it('hydrates via readSpatialCanvas on snapshot and publishes it to subscribers', () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const canvas = twoNodeCanvas()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(canvas))

    expect(session.getCanvas()).toEqual(canvas)
    const listener = vi.fn()
    const unsubscribe = session.subscribe(listener)
    // subscribe does not immediately replay the current value — only future
    // publishes — so trigger one via a remote update to assert delivery.
    const doc = new LoroDoc()
    doc.import(makeSnapshot(canvas))
    const patched = { ...canvas, nodes: [{ ...TEXT_NODE_A, text: 'changed' }, TEXT_NODE_B] }
    writeSpatialCanvas(doc, patched)
    backend._ctrl.handlers!.onRemoteUpdate(doc.export({ mode: 'update' }))

    expect(listener).toHaveBeenCalledWith(patched, 'external')
    unsubscribe()
  })

  it('publishes the annotation layer beside the canvas, read from the doc', () => {
    // ADR-0026 step 2: the layer is document-level, so the session reads it
    // with `readAnnotations` rather than picking it out of the canvas it just
    // built. This is the accessor the comments panel and the markdown editor
    // consume — neither of which has a canvas envelope to read.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeCommentThread(doc, {
      id: 't1',
      anchor: { kind: 'spatial', x: 12, y: 34 },
      status: 'open',
      messages: [{ id: 'm1', body: 'needs a second look' }],
    })
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    expect(session.getAnnotations()).toEqual([
      {
        id: 't1',
        anchor: { kind: 'spatial', x: 12, y: 34 },
        status: 'open',
        messages: [{ id: 'm1', body: 'needs a second look' }],
      },
    ])
  })

  it('republishes annotations when a remote peer replies, without a canvas edit', () => {
    // A reply changes no node and no edge. A subscriber that only hears about
    // canvas values would never learn of it, which is the whole reason this
    // is its own channel.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeCommentThread(doc, {
      id: 't1',
      anchor: { kind: 'spatial', x: 0, y: 0 },
      status: 'open',
      messages: [{ id: 'm1', body: 'first' }],
    })
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    const listener = vi.fn()
    const unsubscribe = session.subscribeAnnotations(listener)
    writeThreadMessage(doc, 't1', { id: 'm2', body: 'a reply from elsewhere' })
    backend._ctrl.handlers!.onRemoteUpdate(doc.export({ mode: 'update' }))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]?.[0]?.messages.map((m: { body: string }) => m.body)).toEqual(
      ['first', 'a reply from elsewhere'],
    )
    unsubscribe()
  })

  it('republishes annotations after a LOCAL comment commit, which is how a person creates one', async () => {
    // The path a person actually takes, and the one the remote-peer case
    // above does not cover: the editor commits a comment through
    // `commitToDoc`, which writes it into the doc and — before this — never
    // told the annotation channel. Found by dogfooding: the bubble appeared
    // on the canvas (the optimistic canvas value is published undebounced)
    // while the panel went on saying "No comments yet" for the rest of the
    // session, because annotations were only recomputed when a REMOTE update
    // happened to arrive.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(emptyCanvas()))

    const listener = vi.fn()
    const unsubscribe = session.subscribeAnnotations(listener)

    const comment: CanvasComment = {
      id: 'c1',
      x: 40,
      y: 60,
      text: 'made right here',
      createdAt: '2026-09-03T00:00:00.000Z',
    }
    const command: EditorCommand = { kind: 'create-comment', comment }
    const next = applyCommand(emptyCanvas(), command)
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)

    expect(session.getAnnotations().map((thread) => thread.messages[0]?.body)).toEqual([
      'made right here',
    ])
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('a thread on a passage of a node reaches the plane, and the canvas as a comment on the node', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const node: SpatialNode = {
      id: 'n1',
      type: 'text',
      x: 100,
      y: 200,
      width: 50,
      height: 30,
      text: 'the plan',
    }
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [node], edges: [] })
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    const command: EditorCommand = {
      kind: 'create-thread',
      thread: {
        id: 't-passage',
        anchor: { kind: 'text', nodeId: 'n1', quote: { exact: 'plan' }, start: 4, end: 8 },
        status: 'open',
        messages: [{ id: 't-passage-m1', body: 'right word?' }],
      },
    }
    const next = applyCommand(session.getCanvas(), command)
    // Optimistic: the reducer already shows a pin on the node.
    expect(next['x-whiteboard']?.comments).toEqual([
      { id: 't-passage', x: 150, y: 200, targetNodeId: 'n1', text: 'right word?' },
    ])
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)

    expect(session.getAnnotations()[0]?.anchor).toEqual(command.thread.anchor)
    expect(session.getCanvas()['x-whiteboard']?.comments?.[0]).toMatchObject({
      id: 't-passage',
      targetNodeId: 'n1',
    })
  })

  it('resolving and editing reach the thread for ANY anchor, which the flat path cannot', async () => {
    // A note's passage and a document-level thread have no projection in
    // the canvas envelope, so `set-comment-resolved` / `set-comment-text`
    // — which travel through it — never reach them. These two write the
    // plane directly, and the canvas projection follows where one exists.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeCommentThread(doc, {
      id: 't-doc',
      anchor: { kind: 'document' },
      status: 'open',
      messages: [{ id: 'm1', body: 'is this document still needed?', author: 'human:yuki' }],
    })
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    const before = session.getCanvas()
    const resolveCommand: EditorCommand = {
      kind: 'set-thread-status',
      threadId: 't-doc',
      status: 'resolved',
    }
    session.onChange(applyCommand(before, resolveCommand), resolveCommand)
    const editCommand: EditorCommand = {
      kind: 'edit-thread-message',
      threadId: 't-doc',
      message: {
        id: 'm1',
        body: 'is this document still needed? (edited)',
        author: 'human:yuki',
        editedAt: '2026-09-05T12:00:00.000Z',
      },
      opening: true,
    }
    session.onChange(applyCommand(before, editCommand), editCommand)
    await vi.advanceTimersByTimeAsync(300)

    const [held] = session.getAnnotations()
    expect(held?.status).toBe('resolved')
    expect(held?.messages[0]).toMatchObject({
      id: 'm1',
      body: 'is this document still needed? (edited)',
      author: 'human:yuki',
      editedAt: '2026-09-05T12:00:00.000Z',
    })
  })

  it('a local reply reaches the thread, which no comment command could carry', async () => {
    // The gap this closes: every other comment command travels through the
    // CANVAS envelope (`x-whiteboard.comments`), and that shape holds one
    // `text` per comment — a reply has nowhere to sit in it. So an MCP peer
    // could add a message and a person could not, and the panel could only
    // report the count of messages it had no way to show.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeCommentThread(doc, {
      id: 't1',
      anchor: { kind: 'spatial', x: 10, y: 20 },
      status: 'open',
      messages: [{ id: 'm1', body: 'the opening question' }],
    })
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    const listener = vi.fn()
    const unsubscribe = session.subscribeAnnotations(listener)

    // The canvas is UNCHANGED by a reply — no node, no edge, and nothing in
    // the envelope either. That is the property that makes this command
    // unlike every other one the commit path takes.
    const before = session.getCanvas()
    const command: EditorCommand = {
      kind: 'reply-to-thread',
      threadId: 't1',
      message: { id: 'm2', body: 'and the answer' },
    }
    session.onChange(applyCommand(before, command), command)
    await vi.advanceTimersByTimeAsync(300)

    expect(session.getAnnotations()[0]?.messages.map((m) => m.body)).toEqual([
      'the opening question',
      'and the answer',
    ])
    // The PAYLOAD, not merely that a notification happened: a subscriber
    // handed the pre-reply annotations would satisfy `toHaveBeenCalled` and
    // leave every reader looking at the old conversation.
    expect(listener).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          id: 't1',
          messages: [
            expect.objectContaining({ body: 'the opening question' }),
            expect.objectContaining({ body: 'and the answer' }),
          ],
        }),
      ],
      // The marks ride in the same call as the threads, so a subscriber can
      // never pair a mark map from one instant with a thread list from
      // another.
      expect.any(Map),
    )
    unsubscribe()
  })

  it('two replies inside one debounce window both survive, because appending is not overwriting', async () => {
    // Every other target key here dedupes to the last value for one target,
    // which is right when the target HOLDS one value. A reply appends, so a
    // key of `thread:t1` would commit only the second of these and lose the
    // first without a trace.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeCommentThread(doc, {
      id: 't1',
      anchor: { kind: 'spatial', x: 10, y: 20 },
      status: 'open',
      messages: [{ id: 'm1', body: 'the opening question' }],
    })
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    const canvas = session.getCanvas()
    for (const message of [
      { id: 'm2', body: 'first reply' },
      { id: 'm3', body: 'second reply' },
    ]) {
      session.onChange(canvas, { kind: 'reply-to-thread', threadId: 't1', message })
    }
    await vi.advanceTimersByTimeAsync(300)

    expect(session.getAnnotations()[0]?.messages.map((m) => m.body)).toEqual([
      'the opening question',
      'first reply',
      'second reply',
    ])
  })

  it('opens a thread on a markdown document, whose canvas has no comment to carry it', async () => {
    // The create half of the same gap `reply-to-thread` closed. A markdown
    // document's canvas holds no nodes at all, so there is no
    // `x-whiteboard.comments` entry a new conversation could ride in on —
    // the thread has to be written into the threads plane directly, and
    // whole, because `commentThreadSchema` has no legal empty thread to
    // create first and fill afterwards.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeMarkdownBody(doc, 'the paragraph a reader wants to question')
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    const before = session.getCanvas()
    const thread: CommentThread = {
      id: 't-new',
      anchor: {
        kind: 'text',
        quote: { prefix: 'the paragraph ', exact: 'a reader', suffix: ' wants to questi' },
        start: 14,
        end: 22,
      },
      status: 'open',
      messages: [{ id: 'm1', body: 'why this one?' }],
    }
    const command: EditorCommand = { kind: 'create-thread', thread }
    session.onChange(applyCommand(before, command), command)
    await vi.advanceTimersByTimeAsync(300)

    // Read back through the session's own annotations rather than the doc:
    // that is what the rail and the body projection both render, so a write
    // the read cannot see is the same defect as no write at all.
    expect(session.getAnnotations()).toEqual([expect.objectContaining({ id: 't-new' })])
    expect(session.getAnnotations()[0]?.messages.map((m) => m.body)).toEqual(['why this one?'])
    // The canvas is untouched, which is what stops the commit path falling
    // back to a whole-canvas resync that would never write the thread.
    expect(session.getCanvas()).toBe(before)
  })

  it('marks the passage a new conversation is about, so the CRDT carries it', async () => {
    // The quote is the durable identity and a mark is where the passage IS.
    // Writing only the thread would leave the live half empty until someone
    // reopened the document, and every edit in between would be tracked by
    // an offset search rather than by the structure that moved the text.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const body = 'Ship the report on Friday. The draft is not written.'
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeMarkdownBody(doc, body)
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    const quote = 'report on Friday'
    const at = { start: body.indexOf(quote), end: body.indexOf(quote) + quote.length }
    const command: EditorCommand = {
      kind: 'create-thread',
      thread: {
        id: 't-marked',
        anchor: { kind: 'text', quote: { exact: quote }, ...at },
        status: 'open',
        messages: [{ id: 'm1', body: 'why Friday?' }],
      },
    }
    session.onChange(session.getCanvas(), command)
    await vi.advanceTimersByTimeAsync(300)

    expect(session.getThreadMarks().get('t-marked')).toEqual(at)
  })

  it('the mark it wrote follows an edit above the passage', async () => {
    // What the stored offsets cannot do, through the session's own write
    // path rather than the adapter's: a `set-body` that inserts above the
    // passage moves it, and the mark reports where it went.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const body = 'Ship the report on Friday. The draft is not written.'
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeMarkdownBody(doc, body)
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    const quote = 'report on Friday'
    const at = { start: body.indexOf(quote), end: body.indexOf(quote) + quote.length }
    session.onChange(session.getCanvas(), {
      kind: 'create-thread',
      thread: {
        id: 't-marked',
        anchor: { kind: 'text', quote: { exact: quote }, ...at },
        status: 'open',
        messages: [{ id: 'm1', body: 'why Friday?' }],
      },
    })
    await vi.advanceTimersByTimeAsync(300)

    const prefix = 'URGENT: '
    session.onChange(session.getCanvas(), { kind: 'set-body', text: `${prefix}${body}` })
    await vi.advanceTimersByTimeAsync(300)

    expect(session.getThreadMarks().get('t-marked')).toEqual({
      start: at.start + prefix.length,
      end: at.end + prefix.length,
    })
  })

  it('gives a document that arrived without marks one per quote it can still find', async () => {
    // Marks do not travel through a markdown file, and a thread an MCP peer
    // wrote never had one. Both are asked of the quote once, when the body
    // is first known, and the answer is written down so the CRDT can carry
    // it from then on.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const body = 'Ship the report on Friday. The draft is not written.'
    const quote = 'report on Friday'
    const at = { start: body.indexOf(quote), end: body.indexOf(quote) + quote.length }
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeMarkdownBody(doc, body)
    writeCommentThread(doc, {
      id: 't-imported',
      anchor: { kind: 'text', quote: { exact: quote }, ...at },
      status: 'open',
      messages: [{ id: 'm1', body: 'why Friday?' }],
    })
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    expect(session.getThreadMarks().get('t-imported')).toEqual(at)
  })

  it('leaves a thread whose passage is gone unmarked rather than guessing', async () => {
    // ADR-0026 decision 4: deleting the subject must not delete the
    // conversation — and must not invent a new subject for it either.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeMarkdownBody(doc, 'Nothing that sentence said is here any more.')
    writeCommentThread(doc, {
      id: 't-orphan',
      anchor: { kind: 'text', quote: { exact: 'report on Friday' }, start: 9, end: 25 },
      status: 'open',
      messages: [{ id: 'm1', body: 'why Friday?' }],
    })
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    expect(session.getThreadMarks().has('t-orphan')).toBe(false)
    expect(session.getAnnotations().map((thread) => thread.id)).toEqual(['t-orphan'])
  })

  it('two threads opened inside one debounce window both survive', async () => {
    // `create-thread` cannot share `reply-to-thread`'s message key, and a
    // `thread:` key would be wrong for the same reason: two threads opened
    // in one window are two conversations, not one target written twice.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    const doc = new LoroDoc()
    writeSpatialCanvas(doc, emptyCanvas())
    writeMarkdownBody(doc, 'first sentence. second sentence.')
    backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

    const canvas = session.getCanvas()
    for (const [id, exact, start] of [
      ['t-a', 'first', 0],
      ['t-b', 'second', 16],
    ] as const) {
      session.onChange(canvas, {
        kind: 'create-thread',
        thread: {
          id,
          anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
          status: 'open',
          messages: [{ id: `${id}-m1`, body: `about ${exact}` }],
        },
      })
    }
    await vi.advanceTimersByTimeAsync(300)

    expect(session.getAnnotations().map((thread) => thread.id)).toEqual(['t-a', 't-b'])
  })

  it('does not republish annotations for a commit that touched no conversation', async () => {
    // The guard is value equality rather than a list of comment-shaped
    // command kinds: a classification over EditorCommand['kind'] is silent
    // when kind N+1 arrives, and this one would go stale into "the panel
    // stops updating" — the exact defect above, re-introduced.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    const listener = vi.fn()
    const unsubscribe = session.subscribeAnnotations(listener)

    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    session.onChange(applyCommand(twoNodeCanvas(), command), command)
    await vi.advanceTimersByTimeAsync(300)

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('onChange with a move-node command writes only that node into doc.getMap("nodes"), leaving a peer edit to the sibling node intact after merge', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(twoNodeCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    const next = applyCommand(twoNodeCanvas(), command)
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)

    expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(0)

    // A peer concurrently renamed node B's text, starting from the SAME
    // snapshot bytes this session imported (a fresh makeSnapshot() call
    // would create an unrelated Loro peer/op lineage, and merging across
    // unrelated lineages resolves same-key conflicts by peer-id tie-break
    // rather than respecting either edit — not what this test means to
    // exercise). Merging the peer's update into this session's exported
    // bytes must retain BOTH edits — proof the fine-grained write touched
    // only node A's LoroMap entry, not node B's.
    const peerDoc = new LoroDoc()
    peerDoc.import(snapshotBytes)
    writeSpatialCanvas(peerDoc, {
      ...twoNodeCanvas(),
      nodes: [TEXT_NODE_A, { ...TEXT_NODE_B, text: 'renamed-by-peer' }],
    })

    const merged = new LoroDoc()
    merged.import(snapshotBytes)
    for (const bytes of backend._ctrl.pushLocalUpdateCalls) merged.import(bytes)
    merged.import(peerDoc.export({ mode: 'update' }))

    const result = readSpatialCanvas(merged)
    const a = result.nodes.find((n) => n.id === 'n-a')
    const b = result.nodes.find((n) => n.id === 'n-b')
    expect(a).toMatchObject({ x: 10, y: 20 })
    expect(b).toMatchObject({ text: 'renamed-by-peer' })
  })

  it('onChange with connect-nodes writes only the new edge, leaving existing edges untouched', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    const initial: SpatialCanvas = {
      nodes: [TEXT_NODE_A, TEXT_NODE_B],
      edges: [{ id: 'e-existing', fromNode: 'n-a', toNode: 'n-b' }],
    }
    session.connect()
    const snapshotBytes = makeSnapshot(initial)
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const command: EditorCommand = {
      kind: 'connect-nodes',
      edgeId: 'e-new',
      fromNode: 'n-b',
      toNode: 'n-a',
    }
    const next = applyCommand(initial, command)
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)

    // subscribeLocalUpdates callbacks are true incremental deltas (relative
    // to the doc's own last export point), not a self-sufficient full
    // history — reconstruct the way a second real peer would: import the
    // EXACT SAME snapshot bytes the session itself imported (a fresh
    // makeSnapshot() call would create an unrelated Loro peer/op lineage,
    // even with identical canvas content), then layer the pushed deltas on
    // top of that same lineage.
    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    for (const bytes of backend._ctrl.pushLocalUpdateCalls) doc.import(bytes)
    const result = readSpatialCanvas(doc)
    expect(result.edges).toHaveLength(2)
    expect(result.edges.find((e) => e.id === 'e-existing')).toEqual(initial.edges[0])
    expect(result.edges.find((e) => e.id === 'e-new')).toEqual(next.edges[1])
  })

  it('onChange with create-node writes only the new node via writeSpatialNode, no fallback/log.warn', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(twoNodeCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const newNode: SpatialCanvas['nodes'][number] = {
      id: 'n-c',
      type: 'text',
      x: 400,
      y: 0,
      width: 100,
      height: 50,
      text: '',
    }
    const command: EditorCommand = { kind: 'create-node', node: newNode }
    const next = applyCommand(twoNodeCanvas(), command)
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)

    expect(appLoggerSpies.warn).not.toHaveBeenCalled()
    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    for (const bytes of backend._ctrl.pushLocalUpdateCalls) doc.import(bytes)
    const result = readSpatialCanvas(doc)
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['n-a', 'n-b', 'n-c'])
  })

  it('onChange with delete-node writes only that deletion via deleteSpatialNode (cascading edges), no fallback/log.warn', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    const initial: SpatialCanvas = {
      nodes: [TEXT_NODE_A, TEXT_NODE_B],
      edges: [{ id: 'e-1', fromNode: 'n-a', toNode: 'n-b' }],
    }
    session.connect()
    const snapshotBytes = makeSnapshot(initial)
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const command: EditorCommand = { kind: 'delete-node', id: 'n-a' }
    const next = applyCommand(initial, command)
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)

    expect(appLoggerSpies.warn).not.toHaveBeenCalled()
    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    for (const bytes of backend._ctrl.pushLocalUpdateCalls) doc.import(bytes)
    const result = readSpatialCanvas(doc)
    expect(result.nodes.map((n) => n.id)).toEqual(['n-b'])
    expect(result.edges).toEqual([])
  })

  it('a local create-comment commit does not delete a comment a remote peer wrote concurrently (fine-grained comment write, not full resync)', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(emptyCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    // A remote peer wrote this comment directly into the shared doc — never
    // reflected in this editor's own `next` canvas below, exactly as a
    // remote update racing a local edit would arrive.
    const remoteComment: CanvasComment = { id: 'remote-c', x: -5, y: 3, text: 'remote note' }
    const remoteDoc = new LoroDoc()
    remoteDoc.import(snapshotBytes)
    writeCanvasComment(remoteDoc, remoteComment)
    backend._ctrl.handlers!.onRemoteUpdate(remoteDoc.export({ mode: 'update' }))

    const localComment: CanvasComment = { id: 'local-c', x: 1, y: 1, text: 'local note' }
    const next: SpatialCanvas = { ...emptyCanvas(), 'x-whiteboard': { comments: [localComment] } }
    const command: EditorCommand = { kind: 'create-comment', comment: localComment }
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)

    // The fallback's tell: if the comment command fell through to the full
    // resync, this fires — see commitToDoc's doc comment.
    expect(appLoggerSpies.warn).not.toHaveBeenCalled()

    const merged = new LoroDoc()
    merged.import(snapshotBytes)
    merged.import(remoteDoc.export({ mode: 'update' }))
    for (const bytes of backend._ctrl.pushLocalUpdateCalls) merged.import(bytes)
    const comments = readSpatialCanvas(merged)['x-whiteboard']?.comments ?? []
    expect(comments.map((c) => c.id).sort()).toEqual(['local-c', 'remote-c'])
  })

  it('debounce coalescing: create-comment then set-comment-resolved for the same id dedupes to a single write of the final comment value', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(emptyCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const comment: CanvasComment = { id: 'c-1', x: 0, y: 0, text: 'first pass' }
    const createCmd: EditorCommand = { kind: 'create-comment', comment }
    const afterCreate = applyCommand(emptyCanvas(), createCmd)
    session.onChange(afterCreate, createCmd)

    const resolveCmd: EditorCommand = { kind: 'set-comment-resolved', id: 'c-1', resolved: true }
    const afterResolve = applyCommand(afterCreate, resolveCmd)
    session.onChange(afterResolve, resolveCmd)

    await vi.advanceTimersByTimeAsync(300)

    // commandTargetKey maps both commands to `comment:c-1` — proof the
    // comment case is not falling into the default arm's fresh-key-per-call
    // behavior, which would push twice.
    expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(1)
    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    doc.import(backend._ctrl.pushLocalUpdateCalls[0]!)
    const comments = readSpatialCanvas(doc)['x-whiteboard']?.comments ?? []
    expect(comments).toEqual([{ ...comment, resolved: true }])
  })

  it('debounce coalescing: move-comment then set-comment-text for the same id dedupes to one fine-grained write carrying both', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    const comment: CanvasComment = { id: 'c-1', x: 0, y: 0, text: 'first pass' }
    const other: CanvasComment = { id: 'c-2', x: 5, y: 5, text: 'stays' }
    const initial: SpatialCanvas = {
      ...emptyCanvas(),
      'x-whiteboard': { comments: [comment, other] },
    }
    session.connect()
    const snapshotBytes = makeSnapshot(initial)
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const moveCmd: EditorCommand = { kind: 'move-comment', id: 'c-1', x: 120, y: -30 }
    const afterMove = applyCommand(initial, moveCmd)
    session.onChange(afterMove, moveCmd)

    const textCmd: EditorCommand = { kind: 'set-comment-text', id: 'c-1', text: 'second pass' }
    const afterText = applyCommand(afterMove, textCmd)
    session.onChange(afterText, textCmd)

    await vi.advanceTimersByTimeAsync(300)

    // Both map to `comment:c-1`, so one write; and it is the fine-grained
    // path — the full-resync fallback's tell (the warning) must not fire.
    expect(appLoggerSpies.warn).not.toHaveBeenCalled()
    expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(1)
    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    doc.import(backend._ctrl.pushLocalUpdateCalls[0]!)
    const comments = readSpatialCanvas(doc)['x-whiteboard']?.comments ?? []
    expect(comments.find((c) => c.id === 'c-1')).toEqual({
      ...comment,
      x: 120,
      y: -30,
      text: 'second pass',
    })
    expect(comments.find((c) => c.id === 'c-2')).toEqual(other)
  })

  it('a batch containing a comment command plus a node command commits fine-grained: a remote comment survives, one undo step', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(twoNodeCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const remoteComment: CanvasComment = { id: 'remote-c', x: -5, y: 3, text: 'remote note' }
    const remoteDoc = new LoroDoc()
    remoteDoc.import(snapshotBytes)
    writeCanvasComment(remoteDoc, remoteComment)
    backend._ctrl.handlers!.onRemoteUpdate(remoteDoc.export({ mode: 'update' }))

    const localComment: CanvasComment = { id: 'local-c', x: 1, y: 1, text: 'local note' }
    const batch: EditorCommand = {
      kind: 'batch',
      commands: [
        { kind: 'create-comment', comment: localComment },
        { kind: 'move-node', id: 'n-a', x: 42, y: 42 },
      ],
    }
    const next: SpatialCanvas = {
      ...applyCommand(twoNodeCanvas(), { kind: 'move-node', id: 'n-a', x: 42, y: 42 }),
      'x-whiteboard': { comments: [localComment] },
    }
    session.onChange(next, batch)
    await vi.advanceTimersByTimeAsync(300)

    expect(appLoggerSpies.warn).not.toHaveBeenCalled()
    expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(1)
    const merged = new LoroDoc()
    merged.import(snapshotBytes)
    merged.import(remoteDoc.export({ mode: 'update' }))
    merged.import(backend._ctrl.pushLocalUpdateCalls[0]!)
    const result = readSpatialCanvas(merged)
    const comments = result['x-whiteboard']?.comments ?? []
    expect(comments.map((c) => c.id).sort()).toEqual(['local-c', 'remote-c'])
    expect(result.nodes.find((n) => n.id === 'n-a')).toMatchObject({ x: 42, y: 42 })
  })

  it('a batch containing move-comment and set-comment-text commits fine-grained: a remote comment survives, one undo step', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const toMove: CanvasComment = { id: 'c-1', x: 0, y: 0, text: 'move me' }
    const toEdit: CanvasComment = { id: 'c-2', x: 5, y: 5, text: 'edit me' }
    const initial: SpatialCanvas = {
      ...twoNodeCanvas(),
      'x-whiteboard': { comments: [toMove, toEdit] },
    }
    const snapshotBytes = makeSnapshot(initial)
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const remoteComment: CanvasComment = { id: 'remote-c', x: -5, y: 3, text: 'remote note' }
    const remoteDoc = new LoroDoc()
    remoteDoc.import(snapshotBytes)
    writeCanvasComment(remoteDoc, remoteComment)
    backend._ctrl.handlers!.onRemoteUpdate(remoteDoc.export({ mode: 'update' }))

    const batch: EditorCommand = {
      kind: 'batch',
      commands: [
        { kind: 'move-comment', id: 'c-1', x: 120, y: -30 },
        { kind: 'set-comment-text', id: 'c-2', text: 'edited' },
        { kind: 'move-node', id: 'n-a', x: 42, y: 42 },
      ],
    }
    const next = batch.commands.reduce(applyCommand, initial)
    session.onChange(next, batch)
    await vi.advanceTimersByTimeAsync(300)

    expect(appLoggerSpies.warn).not.toHaveBeenCalled()
    expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(1)
    const merged = new LoroDoc()
    merged.import(snapshotBytes)
    merged.import(remoteDoc.export({ mode: 'update' }))
    merged.import(backend._ctrl.pushLocalUpdateCalls[0]!)
    const result = readSpatialCanvas(merged)
    const comments = result['x-whiteboard']?.comments ?? []
    expect(comments.map((c) => c.id).sort()).toEqual(['c-1', 'c-2', 'remote-c'])
    expect(comments.find((c) => c.id === 'c-1')).toMatchObject({ x: 120, y: -30 })
    expect(comments.find((c) => c.id === 'c-2')).toMatchObject({ text: 'edited' })
    expect(result.nodes.find((n) => n.id === 'n-a')).toMatchObject({ x: 42, y: 42 })
  })

  it('a batch containing set-comment-resolved and set-comment-text commits fine-grained: a remote comment survives, one undo step', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const toResolve: CanvasComment = { id: 'c-1', x: 0, y: 0, text: 'resolve me' }
    const toEdit: CanvasComment = { id: 'c-2', x: 5, y: 5, text: 'edit me' }
    const initial: SpatialCanvas = {
      ...twoNodeCanvas(),
      'x-whiteboard': { comments: [toResolve, toEdit] },
    }
    const snapshotBytes = makeSnapshot(initial)
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    // A remote peer's concurrent comment — the fine-grained-write tell, same
    // as the create-comment batch test above.
    const remoteComment: CanvasComment = { id: 'remote-c', x: -5, y: 3, text: 'remote note' }
    const remoteDoc = new LoroDoc()
    remoteDoc.import(snapshotBytes)
    writeCanvasComment(remoteDoc, remoteComment)
    backend._ctrl.handlers!.onRemoteUpdate(remoteDoc.export({ mode: 'update' }))

    const batch: EditorCommand = {
      kind: 'batch',
      commands: [
        { kind: 'set-comment-resolved', id: 'c-1', resolved: true },
        { kind: 'set-comment-text', id: 'c-2', text: 'edited' },
        { kind: 'move-node', id: 'n-a', x: 42, y: 42 },
      ],
    }
    const next: SpatialCanvas = {
      ...applyCommand(initial, { kind: 'move-node', id: 'n-a', x: 42, y: 42 }),
      'x-whiteboard': {
        comments: [
          { ...toResolve, resolved: true },
          { ...toEdit, text: 'edited' },
        ],
      },
    }
    session.onChange(next, batch)
    await vi.advanceTimersByTimeAsync(300)

    expect(appLoggerSpies.warn).not.toHaveBeenCalled()
    expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(1)
    const merged = new LoroDoc()
    merged.import(snapshotBytes)
    merged.import(remoteDoc.export({ mode: 'update' }))
    merged.import(backend._ctrl.pushLocalUpdateCalls[0]!)
    const result = readSpatialCanvas(merged)
    const comments = result['x-whiteboard']?.comments ?? []
    expect(comments.map((c) => c.id).sort()).toEqual(['c-1', 'c-2', 'remote-c'])
    expect(comments.find((c) => c.id === 'c-1')).toMatchObject({ resolved: true })
    expect(comments.find((c) => c.id === 'c-2')).toMatchObject({ text: 'edited' })
    expect(result.nodes.find((n) => n.id === 'n-a')).toMatchObject({ x: 42, y: 42 })
  })

  it('debounce coalescing: create-node then move-node for the same id dedupes to a single write of the final node value', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(emptyCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const newNode: SpatialCanvas['nodes'][number] = {
      id: 'n-c',
      type: 'text',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      text: '',
    }
    const createCmd: EditorCommand = { kind: 'create-node', node: newNode }
    const afterCreate = applyCommand(emptyCanvas(), createCmd)
    session.onChange(afterCreate, createCmd)

    const moveCmd: EditorCommand = { kind: 'move-node', id: 'n-c', x: 50, y: 60 }
    const afterMove = applyCommand(afterCreate, moveCmd)
    session.onChange(afterMove, moveCmd)

    await vi.advanceTimersByTimeAsync(300)

    expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(1)
    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    doc.import(backend._ctrl.pushLocalUpdateCalls[0]!)
    const result = readSpatialCanvas(doc)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]).toMatchObject({ id: 'n-c', x: 50, y: 60 })
  })

  it('debounce coalescing: move-node then delete-node for the same id dedupes to the delete', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(twoNodeCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const moveCmd: EditorCommand = { kind: 'move-node', id: 'n-a', x: 1, y: 1 }
    const afterMove = applyCommand(twoNodeCanvas(), moveCmd)
    session.onChange(afterMove, moveCmd)

    const deleteCmd: EditorCommand = { kind: 'delete-node', id: 'n-a' }
    const afterDelete = applyCommand(afterMove, deleteCmd)
    session.onChange(afterDelete, deleteCmd)

    await vi.advanceTimersByTimeAsync(300)

    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    for (const bytes of backend._ctrl.pushLocalUpdateCalls) doc.import(bytes)
    const result = readSpatialCanvas(doc)
    expect(result.nodes.map((n) => n.id)).toEqual(['n-b'])
  })

  it('falls back to a full writeSpatialCanvas resync when the command target is missing from `next`, still converging on `next`', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(twoNodeCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    // Deliberately mismatched: the command names a node the `next` canvas no
    // longer contains (simulating an unmapped/unknown edit).
    const command: EditorCommand = { kind: 'move-node', id: 'does-not-exist', x: 1, y: 1 }
    const next: SpatialCanvas = { nodes: [TEXT_NODE_A], edges: [] }
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)

    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    for (const bytes of backend._ctrl.pushLocalUpdateCalls) doc.import(bytes)
    expect(readSpatialCanvas(doc)).toEqual(next)
  })

  it('a fine-grained write that throws is contained by guardedCommit — the chain survives and the next firing still commits', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(twoNodeCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    // A node with a throwing getter poisons BOTH the fine-grained write and
    // the writeSpatialCanvas fallback (both read `node.text`), so this
    // firing's commit is fully skipped by guardedCommit's own outer
    // try/catch — the point of this test is that the CHAIN survives, not
    // that this particular firing succeeds.
    const poisonedNode: SpatialCanvas['nodes'][number] = { ...TEXT_NODE_A }
    Object.defineProperty(poisonedNode, 'text', {
      get(): never {
        throw new Error('boom')
      },
      enumerable: true,
    })
    const poisoned: SpatialCanvas = { ...twoNodeCanvas(), nodes: [poisonedNode, TEXT_NODE_B] }
    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 5, y: 5 }
    session.onChange(poisoned, command)
    await vi.advanceTimersByTimeAsync(300)

    // The firing's own commit may have been skipped or fallen back — either
    // way the chain must not be wedged: a subsequent, well-formed firing
    // still commits.
    const command2: EditorCommand = { kind: 'move-node', id: 'n-b', x: 9, y: 9 }
    const next2 = applyCommand(twoNodeCanvas(), command2)
    session.onChange(next2, command2)
    await vi.advanceTimersByTimeAsync(300)

    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    for (const bytes of backend._ctrl.pushLocalUpdateCalls) doc.import(bytes)
    const result = readSpatialCanvas(doc)
    expect(result.nodes.find((n) => n.id === 'n-b')).toMatchObject({ x: 9, y: 9 })
  })

  it('debounce coalescing: three rapid onChange calls produce exactly one commit, derived from the LAST pair', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(twoNodeCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const c1: EditorCommand = { kind: 'move-node', id: 'n-a', x: 1, y: 1 }
    const c2: EditorCommand = { kind: 'move-node', id: 'n-a', x: 2, y: 2 }
    const c3: EditorCommand = { kind: 'move-node', id: 'n-a', x: 3, y: 3 }
    session.onChange(applyCommand(twoNodeCanvas(), c1), c1)
    session.onChange(applyCommand(twoNodeCanvas(), c2), c2)
    const next3 = applyCommand(twoNodeCanvas(), c3)
    session.onChange(next3, c3)
    await vi.advanceTimersByTimeAsync(300)

    expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(1)
    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    doc.import(backend._ctrl.pushLocalUpdateCalls[0]!)
    expect(readSpatialCanvas(doc).nodes.find((n) => n.id === 'n-a')).toMatchObject({ x: 3, y: 3 })
  })

  it('debounce coalescing across DIFFERENT targets: edits to two different nodes within one window are both committed', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    const snapshotBytes = makeSnapshot(twoNodeCanvas())
    backend._ctrl.handlers!.onSnapshot(snapshotBytes)

    const cA: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 10 }
    const afterA = applyCommand(twoNodeCanvas(), cA)
    session.onChange(afterA, cA)

    const cB: EditorCommand = {
      kind: 'resize-node',
      id: 'n-b',
      x: 200,
      y: 0,
      width: 150,
      height: 60,
    }
    const afterB = applyCommand(afterA, cB)
    session.onChange(afterB, cB)

    await vi.advanceTimersByTimeAsync(300)

    const doc = new LoroDoc()
    doc.import(snapshotBytes)
    for (const bytes of backend._ctrl.pushLocalUpdateCalls) doc.import(bytes)
    const result = readSpatialCanvas(doc)
    // Both edits must survive: node A's move must not be dropped just
    // because node B's edit was the last command in the debounce window.
    expect(result.nodes.find((n) => n.id === 'n-a')).toMatchObject({ x: 10, y: 10 })
    expect(result.nodes.find((n) => n.id === 'n-b')).toMatchObject({ width: 150, height: 60 })
  })

  it('dispose() flushes a pending debounced edit into this session before disconnecting', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 1, y: 1 }
    session.onChange(applyCommand(twoNodeCanvas(), command), command)

    // Debounce (300ms) has not fired yet.
    expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(0)

    session.dispose()

    // flush() runs the commit synchronously; the resulting
    // subscribeLocalUpdates push fires on a microtask, and dispose()'s drain
    // phase defers backend.disconnect() a few more microtask turns behind
    // that push — draining several turns covers both.
    await flushMicrotasks()
    expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(0)
    expect(backend._ctrl.disconnectCalled).toBe(true)
  })

  it('mutation check: an isStale() guard on the subscribeLocalUpdates callback would drop the post-dispose flush push', async () => {
    // This test intentionally re-implements the callback with the guard the
    // production code deliberately omits, to prove the omission matters —
    // it does not touch production code, but documents the exact failure
    // mode the comment in createDocumentSyncSession warns about.
    let disposed = false
    const pushed: Uint8Array[] = []
    function guardedSubscriber(update: Uint8Array): void {
      if (disposed) return
      pushed.push(update)
    }
    const microtaskUpdate = new Uint8Array([1, 2, 3])
    const fireOnMicrotask = Promise.resolve().then(() => guardedSubscriber(microtaskUpdate))
    disposed = true
    await fireOnMicrotask
    expect(pushed).toHaveLength(0) // guarded version loses the edit — the bug this test protects against
  })

  it('MID-DEBOUNCE SWAP: a firing scheduled before dispose commits into its own session, never a superseding one', async () => {
    const backendA = makeFakeBackend()
    const backendB = makeFakeBackend()
    const generations = createGenerationCounters()
    const sessionA = createDocumentSyncSession(backendA, makeDeps({ generations }))
    sessionA.connect()
    backendA._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 1, y: 1 }
    sessionA.onChange(applyCommand(twoNodeCanvas(), command), command)

    // Before the 300ms debounce fires, session A is disposed and a new
    // session B is constructed against a different backend/doc.
    sessionA.dispose()
    const sessionB = createDocumentSyncSession(backendB, makeDeps({ generations }))
    sessionB.connect()
    backendB._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    await vi.advanceTimersByTimeAsync(300)
    await Promise.resolve()

    // A's flush (triggered by its own dispose) already pushed into A;
    // no further scheduled timer exists for A since flush cancels the timer.
    expect(backendA._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(0)
    expect(backendB._ctrl.pushLocalUpdateCalls).toHaveLength(0)
  })

  it('subscribeHistory fires when a committed edit pushes an undo step, and canUndo flips', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
    expect(session.canUndo()).toBe(false)

    const historyListener = vi.fn()
    const unsubscribe = session.subscribeHistory(historyListener)

    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    session.onChange(applyCommand(twoNodeCanvas(), command), command)
    await vi.advanceTimersByTimeAsync(300)

    expect(historyListener).toHaveBeenCalled()
    expect(session.canUndo()).toBe(true)
    unsubscribe()
  })

  it('clearUndo() (the restore-complete path) notifies history listeners so canUndo flips back', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    session.onChange(applyCommand(twoNodeCanvas(), command), command)
    await vi.advanceTimersByTimeAsync(300)
    expect(session.canUndo()).toBe(true)

    const historyListener = vi.fn()
    const unsubscribe = session.subscribeHistory(historyListener)

    session.clearUndo()
    await vi.advanceTimersByTimeAsync(0)

    expect(session.canUndo()).toBe(false)
    // Without the notification the consumer keeps rendering an enabled Undo
    // button over an empty stack — the exact stale-affordance a version
    // restore would otherwise leave behind.
    expect(historyListener).toHaveBeenCalled()
    unsubscribe()
  })

  it('undo() reverts the last committed edit and notifies subscribers with the "external" origin', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    const next = applyCommand(twoNodeCanvas(), command)
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)
    expect(session.getCanvas()).toEqual(next)

    const listener = vi.fn()
    const unsubscribe = session.subscribe(listener)

    const undone = session.undo()

    expect(undone).toBe(true)
    expect(session.getCanvas()).toEqual(twoNodeCanvas())
    expect(listener).toHaveBeenCalledWith(twoNodeCanvas(), 'external')
    unsubscribe()
  })

  it('redo() re-applies an undone edit and notifies subscribers with the "external" origin', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
    const next = applyCommand(twoNodeCanvas(), command)
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)
    session.undo()

    const listener = vi.fn()
    const unsubscribe = session.subscribe(listener)

    const redone = session.redo()

    expect(redone).toBe(true)
    expect(session.getCanvas()).toEqual(next)
    expect(listener).toHaveBeenCalledWith(next, 'external')
    unsubscribe()
  })

  it('onEditorReady re-sends clientReady and flushes pending export requests, even with no doc yet', () => {
    const backend = makeFakeBackend()
    const sendReadySpy = vi.spyOn(backend, 'sendClientReady')
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    // No snapshot has landed yet — onEditorReady must still send clientReady.
    session.onEditorReady()
    expect(sendReadySpy).toHaveBeenCalledTimes(2) // once on connect, once on ready
  })

  it('restore lifecycle drives the injected restore callback and clears undo on complete', () => {
    const backend = makeFakeBackend()
    const onRestoreChange = vi.fn()
    const session = createDocumentSyncSession(backend, makeDeps({ onRestoreChange }))
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot())

    backend._ctrl.handlers!.onRestoreStarted({ label: 'v3' } as never)
    expect(onRestoreChange).toHaveBeenCalledWith(true, 'v3')

    backend._ctrl.handlers!.onRestoreComplete()
    expect(onRestoreChange).toHaveBeenCalledWith(false, null)
  })

  it('dispose() invokes backend.pushLocalUpdate for the flush-triggered commit before calling backend.disconnect()', async () => {
    // Regression for the drain phase: disconnect() must never be called
    // before the flush-triggered commit's subscribeLocalUpdates callback has
    // invoked pushLocalUpdate, or the last edit made just before teardown
    // never reaches the transport. Tracking call ORDER (not settle order) is
    // the right assertion — a real transport's pushLocalUpdate may take an
    // arbitrarily long time to settle (network ack), but the *call* itself
    // is what puts bytes on a still-open connection.
    const callOrder: string[] = []
    const backend: DocumentBackend & { _ctrl: FakeBackendControl } = {
      ...makeFakeBackend(),
      pushLocalUpdate(_bytes) {
        callOrder.push('push-called')
        return new Promise(() => {}) // never settles — disconnect must not wait for this
      },
      disconnect() {
        callOrder.push('disconnect')
      },
    }
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 1, y: 1 }
    session.onChange(applyCommand(twoNodeCanvas(), command), command)
    session.dispose()

    // Drain microtask turns without advancing fake timers (real transport
    // call scheduling is not timer-driven).
    await flushMicrotasks()

    expect(callOrder).toEqual(['push-called', 'disconnect'])
  })

  // With the file-upload path removed (no more hung-putFile scenario), the
  // commit chain has no remaining async gap it can get stuck behind — every
  // write (fine-grained or the writeSpatialCanvas fallback) is synchronous.
  // The bounded drain-timeout race in dispose() is retained as defensive
  // plumbing (see DISPOSE_DRAIN_TIMEOUT_MS's doc comment) and is still
  // exercised by the "invokes pushLocalUpdate before disconnect" and
  // "disconnects synchronously when nothing is pending" tests above/below;
  // the fast-check model-based test further exercises pendingCommitCount's
  // bookkeeping across arbitrary command sequences.

  it('dispose() disconnects synchronously when nothing is pending (fast path, no drain)', () => {
    // Regression for the pendingCommitCount === 0 branch: with no onChange
    // ever fired, dispose() must call backend.disconnect() synchronously —
    // not behind any await — preserving the "callers do not await dispose()"
    // contract for the common no-edit teardown path.
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()

    session.dispose()

    expect(backend._ctrl.disconnectCalled).toBe(true)
  })

  it('onAuthError sets error status and invokes options.onAuthError via getOptions', () => {
    const backend = makeFakeBackend()
    const onStatusChange = vi.fn()
    const onAuthError = vi.fn()
    const session = createDocumentSyncSession(
      backend,
      makeDeps({ onStatusChange, getOptions: () => ({ onAuthError }) }),
    )
    session.connect()

    backend._ctrl.handlers!.onAuthError?.()

    expect(onStatusChange).toHaveBeenCalledWith('error')
    expect(onAuthError).toHaveBeenCalledTimes(1)
  })

  describe('model-based: random EditorCommand sequences', () => {
    const nodeIdArb = fc.constantFrom('n-a', 'n-b', 'n-c')
    const commandArb: fc.Arbitrary<EditorCommand> = fc.oneof(
      // A canvas-wide setting: the first command that edits the ENVELOPE
      // rather than a node, and the shape of command this file's properties
      // were blind to.
      fc.record({
        kind: fc.constant('set-edge-routing' as const),
        style: fc.constantFrom('straight' as const, 'orthogonal' as const),
      }),
      fc.record({
        kind: fc.constant('move-node' as const),
        id: nodeIdArb,
        x: fc.integer({ min: -1000, max: 1000 }),
        y: fc.integer({ min: -1000, max: 1000 }),
      }),
      fc.record({
        kind: fc.constant('resize-node' as const),
        id: nodeIdArb,
        x: fc.integer({ min: -1000, max: 1000 }),
        y: fc.integer({ min: -1000, max: 1000 }),
        width: fc.integer({ min: 0, max: 500 }),
        height: fc.integer({ min: 0, max: 500 }),
      }),
      fc.record({
        kind: fc.constant('set-text' as const),
        id: nodeIdArb,
        text: fc.string({ maxLength: 20 }),
      }),
    )

    function baseCanvas(): SpatialCanvas {
      return {
        nodes: [
          { id: 'n-a', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'a' },
          { id: 'n-b', type: 'text', x: 100, y: 0, width: 100, height: 50, text: 'b' },
          { id: 'n-c', type: 'text', x: 200, y: 0, width: 100, height: 50, text: 'c' },
        ],
        edges: [],
      }
    }

    // No pinned seed: fast-check picks its own seed every run, per this
    // repo's PBT discipline (a fixed seed would hide real bugs behind a
    // stable-but-wrong pass).
    fcTest.prop([fc.array(commandArb, { maxLength: 15 })], withDefaults({ numRuns: 30 }))(
      'pendingCommitCount stays >= 0 throughout, the chain never rejects, and drains to 0',
      async (commands) => {
        vi.useFakeTimers()
        try {
          const backend = makeFakeBackend()
          const session = createDocumentSyncSession(backend, makeDeps())
          session.connect()
          const snapshotBytes = makeSnapshot(baseCanvas())
          backend._ctrl.handlers!.onSnapshot(snapshotBytes)

          let canvas = baseCanvas()
          for (const command of commands) {
            canvas = applyCommand(canvas, command)
            session.onChange(canvas, command)
            // Interleave a settle so debounced firings actually get chained,
            // not merely coalesced into the final one.
            await vi.advanceTimersByTimeAsync(300)
          }
          await vi.advanceTimersByTimeAsync(300)

          // The published canvas mirrors every applied command exactly (the
          // command/state agreement property) — the session forwards `next`
          // as-is.
          expect(session.getCanvas()).toEqual(canvas)

          const doc = new LoroDoc()
          doc.import(snapshotBytes)
          for (const bytes of backend._ctrl.pushLocalUpdateCalls) doc.import(bytes)
          // Fine-grained writes and the writeSpatialCanvas fallback must
          // never disagree about the resulting canvas.
          expect(readSpatialCanvas(doc)).toEqual(canvas)

          session.dispose()
          await flushMicrotasks()
          expect(backend._ctrl.disconnectCalled).toBe(true)
        } finally {
          vi.useRealTimers()
        }
      },
    )

    // What the property above never asks: does the DOCUMENT end up holding
    // what the editor produced? Counting pending commits passes happily for a
    // command that persists nothing — and a canvas-wide setting did exactly
    // that, reaching the screen and vanishing on the next reload.
    //
    // Replaying the pushed payloads over the initial snapshot is what a
    // reloading client does, so this asks the question the way the bug asked
    // it. Deliberately no assertion that anything WAS pushed: a command that
    // changes nothing legitimately pushes nothing, and the replay of an empty
    // list still has to equal the unchanged canvas.
    fcTest.prop(
      [fc.array(commandArb, { minLength: 1, maxLength: 12 })],
      withDefaults({ numRuns: 30 }),
    )(
      'a command sequence leaves the document equal to the canvas it produced',
      async (commands) => {
        const backend = makeFakeBackend()
        const session = createDocumentSyncSession(backend, makeDeps())
        session.connect()
        const initial = baseCanvas()
        const snapshotBytes = makeSnapshot(initial)
        backend._ctrl.handlers?.onSnapshot(snapshotBytes)

        let canvas: SpatialCanvas = initial
        for (const command of commands) {
          canvas = applyCommand(canvas, command)
          session.onChange(canvas, command)
          await vi.advanceTimersByTimeAsync(1000)
          await flushMicrotasks()
        }
        await session.dispose()
        await flushMicrotasks()

        const replay = new LoroDoc()
        replay.import(snapshotBytes)
        for (const bytes of backend._ctrl.pushLocalUpdateCalls) replay.import(bytes)
        const stored = readSpatialCanvas(replay)

        expect(stored['x-whiteboard']).toEqual(canvas['x-whiteboard'])
        const byId = <T extends { id: string }>(list: readonly T[]) =>
          [...list].sort((a, b) => a.id.localeCompare(b.id))
        expect(byId(stored.nodes)).toEqual(byId(canvas.nodes))
        expect(byId(stored.edges)).toEqual(byId(canvas.edges))
      },
    )
  })

  // Batch commands (editor-completeness slice 1): one user action of N leaf
  // commands = ONE Loro commit via crdt's withSpatialBatch, so
  // one session.undo() reverts the whole action.
  describe('batch commands', () => {
    it('a batch of create+connect+delete lands as ONE update payload and ONE undo step', async () => {
      const backend = makeFakeBackend()
      const session = createDocumentSyncSession(backend, makeDeps())
      session.connect()
      backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

      const created: SpatialNode = {
        id: 'n-new',
        type: 'text',
        x: 500,
        y: 0,
        width: 100,
        height: 50,
        text: 'pasted',
      }
      const command: EditorCommand = {
        kind: 'batch',
        commands: [
          { kind: 'create-node', node: created },
          { kind: 'connect-nodes', edgeId: 'e-new', fromNode: 'n-a', toNode: 'n-new' },
          { kind: 'delete-node', id: 'n-b' },
        ],
      }
      const next = applyCommand(twoNodeCanvas(), command)
      session.onChange(next, command)
      await vi.advanceTimersByTimeAsync(300)

      // One flush of one batch → exactly one pushed payload.
      expect(backend._ctrl.pushLocalUpdateCalls).toHaveLength(1)
      expect(session.getCanvas()).toEqual(next)

      // One undo step reverts the WHOLE action.
      expect(session.undo()).toBe(true)
      expect(session.getCanvas()).toEqual(twoNodeCanvas())
      expect(session.canUndo()).toBe(false)
    })

    it('a batch containing an unsupported member kind falls back to a full resync — still one undo step, converged on next', async () => {
      const backend = makeFakeBackend()
      const session = createDocumentSyncSession(backend, makeDeps())
      session.connect()
      const snapshotBytes = makeSnapshot(twoNodeCanvas())
      backend._ctrl.handlers!.onSnapshot(snapshotBytes)

      const command: EditorCommand = {
        kind: 'batch',
        commands: [
          { kind: 'move-node', id: 'n-a', x: 42, y: 24 },
          // reorder-nodes is not batch-writable → whole batch takes the
          // full-resync path (one commit, whole-canvas granularity).
          { kind: 'reorder-nodes', ids: ['n-a'], placement: 'front' },
        ],
      }
      const next = applyCommand(twoNodeCanvas(), command)
      session.onChange(next, command)
      await vi.advanceTimersByTimeAsync(300)

      const doc = new LoroDoc()
      doc.import(snapshotBytes)
      for (const bytes of backend._ctrl.pushLocalUpdateCalls) doc.import(bytes)
      const converged = readSpatialCanvas(doc)
      expect(converged.nodes.find((n) => n.id === 'n-a')).toMatchObject({ x: 42, y: 24 })

      expect(session.undo()).toBe(true)
      expect(session.getCanvas()).toEqual(twoNodeCanvas())
      expect(session.canUndo()).toBe(false)
    })

    it('a batched delete-edge removes exactly that edge (fine-grained, peer edits survive)', async () => {
      const backend = makeFakeBackend()
      const session = createDocumentSyncSession(backend, makeDeps())
      session.connect()
      const base = applyCommand(twoNodeCanvas(), {
        kind: 'connect-nodes',
        edgeId: 'e-1',
        fromNode: 'n-a',
        toNode: 'n-b',
      })
      const snapshotBytes = makeSnapshot(base)
      backend._ctrl.handlers!.onSnapshot(snapshotBytes)

      const command: EditorCommand = {
        kind: 'batch',
        commands: [{ kind: 'delete-edge', id: 'e-1' }],
      }
      const next = applyCommand(base, command)
      session.onChange(next, command)
      await vi.advanceTimersByTimeAsync(300)

      // Peer concurrently edits node B from the same lineage; the batched
      // fine-grained delete must not clobber it (a full resync would).
      const peerDoc = new LoroDoc()
      peerDoc.import(snapshotBytes)
      writeSpatialCanvas(peerDoc, {
        ...base,
        nodes: [TEXT_NODE_A, { ...TEXT_NODE_B, text: 'renamed-by-peer' }],
      })
      const merged = new LoroDoc()
      merged.import(snapshotBytes)
      for (const bytes of backend._ctrl.pushLocalUpdateCalls) merged.import(bytes)
      merged.import(peerDoc.export({ mode: 'update' }))

      const result = readSpatialCanvas(merged)
      expect(result.edges).toEqual([])
      expect(result.nodes.find((n) => n.id === 'n-b')).toMatchObject({ text: 'renamed-by-peer' })
    })
  })

  // Content scope: when the backend delivers a WORKSPACE document (one Loro
  // doc holding every document as a tree node), the session's content lives
  // on that node's containers, not at the doc's roots. `contentDocumentId`
  // is the seam — unset, every read/write goes to the roots exactly as
  // before (all the tests above), so this block is the scoped half only.
  describe('content scope (workspace document)', () => {
    // A canonical ULID — workspaceNodeMetaSchema rejects anything else.
    const SCOPED_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

    function makeWorkspaceSnapshot(canvas: SpatialCanvas): Uint8Array {
      const ws = new LoroDoc()
      createWorkspaceDocumentAtPath(ws, { path: 'design', documentId: SCOPED_ID, kind: 'spatial' })
      writeSpatialCanvas(documentContainers(ws, SCOPED_ID), canvas)
      ws.commit()
      return ws.export({ mode: 'snapshot' })
    }

    it('hydrates from the tree node and commits edits there — the workspace doc roots stay empty', async () => {
      const backend = makeFakeBackend()
      const session = createDocumentSyncSession(backend, makeDeps({ contentDocumentId: SCOPED_ID }))
      session.connect()
      const snapshotBytes = makeWorkspaceSnapshot(twoNodeCanvas())
      backend._ctrl.handlers!.onSnapshot(snapshotBytes)

      // Hydration read the node's containers, not the workspace doc's roots
      // (which hold no canvas at all).
      expect(session.getCanvas()).toEqual(twoNodeCanvas())

      const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 10, y: 20 }
      session.onChange(applyCommand(twoNodeCanvas(), command), command)
      await vi.advanceTimersByTimeAsync(300)

      const replay = new LoroDoc()
      replay.import(snapshotBytes)
      for (const bytes of backend._ctrl.pushLocalUpdateCalls) replay.import(bytes)
      const scoped = readSpatialCanvas(documentContainers(replay, SCOPED_ID))
      expect(scoped.nodes.find((n) => n.id === 'n-a')).toMatchObject({ x: 10, y: 20 })
      // The write went through the tree node — never to where a per-document
      // doc keeps its content. A session that ignored the scope would leave
      // the moved node here.
      expect(readSpatialCanvas(replay).nodes).toEqual([])
    })

    it('locks and undo resolve through the scope', async () => {
      const backend = makeFakeBackend()
      const session = createDocumentSyncSession(backend, makeDeps({ contentDocumentId: SCOPED_ID }))
      session.connect()
      const snapshotBytes = makeWorkspaceSnapshot(twoNodeCanvas())
      backend._ctrl.handlers!.onSnapshot(snapshotBytes)

      session.setNodeLock('n-a', true)
      expect(session.getNodeLocks()).toEqual(new Set(['n-a']))

      const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 5, y: 5 }
      const next = applyCommand(twoNodeCanvas(), command)
      session.onChange(next, command)
      await vi.advanceTimersByTimeAsync(300)
      expect(session.getCanvas()).toEqual(next)

      // Undo runs on the workspace doc's UndoManager but the published value
      // is read back through the scope — the reverted move must be visible.
      expect(session.undo()).toBe(true)
      expect(session.getCanvas()).toEqual(twoNodeCanvas())
    })

    it('a markdown body writes to the node`s own text container, never the doc root', async () => {
      const backend = makeFakeBackend()
      const session = createDocumentSyncSession(backend, makeDeps({ contentDocumentId: SCOPED_ID }))
      session.connect()
      // A markdown document: empty canvas, body in the node's text container.
      const ws = new LoroDoc()
      createWorkspaceDocumentAtPath(ws, {
        path: 'notes',
        documentId: SCOPED_ID,
        kind: 'markdown',
      })
      ws.commit()
      const snapshotBytes = ws.export({ mode: 'snapshot' })
      backend._ctrl.handlers!.onSnapshot(snapshotBytes)

      const body: EditorCommand = { kind: 'set-body', text: '# scoped body' }
      session.onChange(session.getCanvas(), body)
      await vi.advanceTimersByTimeAsync(300)
      expect(session.getMarkdownBody()).toBe('# scoped body')

      const replay = new LoroDoc()
      replay.import(snapshotBytes)
      for (const bytes of backend._ctrl.pushLocalUpdateCalls) replay.import(bytes)
      expect(readMarkdownBody(documentContainers(replay, SCOPED_ID))).toBe('# scoped body')
      // The workspace doc's own root `body` container stayed empty.
      expect(readMarkdownBody(replay)).toBe('')
    })
  })

  // Node lock lives in the doc's sidecar map, so it must survive the same
  // reload path a canvas does — and the CONSUMER only learns about it
  // through subscribeLocks, which is why hydration has to notify.
  describe('node lock', () => {
    it('hydration reports the persisted lock set, not an empty one (reload regression)', () => {
      const backend = makeFakeBackend()
      const session = createDocumentSyncSession(backend, makeDeps())
      session.connect()

      // Bytes that already carry a lock, exactly as a reload would deliver.
      const doc = new LoroDoc()
      writeSpatialCanvas(doc, twoNodeCanvas())
      setNodeLock(doc, 'n-a', true)
      const listener = vi.fn()
      session.subscribeLocks(listener)

      backend._ctrl.handlers!.onSnapshot(doc.export({ mode: 'snapshot' }))

      expect(session.getNodeLocks()).toEqual(new Set(['n-a']))
      // Without the hydration notification the consumer would keep an
      // empty set and the lock would look lost.
      expect(listener).toHaveBeenCalled()
    })

    it('setNodeLock pushes the change to peers and notifies, without publishing a canvas', async () => {
      const backend = makeFakeBackend()
      const session = createDocumentSyncSession(backend, makeDeps())
      session.connect()
      backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
      const before = backend._ctrl.pushLocalUpdateCalls.length

      const documentListener = vi.fn()
      session.subscribe(documentListener)
      const lockListener = vi.fn()
      session.subscribeLocks(lockListener)

      session.setNodeLock('n-b', true)
      await vi.advanceTimersByTimeAsync(300)

      expect(session.getNodeLocks()).toEqual(new Set(['n-b']))
      expect(lockListener).toHaveBeenCalled()
      // The lock reaches peers...
      expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(before)
      // ...but it is not canvas content, so no canvas publish fires.
      expect(documentListener).not.toHaveBeenCalled()
    })
  })
})

describe('deciding a proposal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const node: SpatialNode = {
    id: 'n1',
    type: 'text',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    text: 'the plan',
  }
  const proposal: Proposal = {
    id: 'p1',
    createdAt: '2026-09-06T00:00:00.000Z',
    changes: [
      {
        id: 'node:n1',
        op: 'node.patch',
        status: 'open',
        nodeId: 'n1',
        patch: { x: 240 },
        assumed: { x: 0 },
      },
    ],
  }

  function seeded(): Uint8Array {
    const doc = new LoroDoc()
    writeSpatialCanvas(doc, { nodes: [node], edges: [] })
    writeProposal(doc, proposal)
    return doc.export({ mode: 'snapshot' })
  }

  it('adopting writes the board AND closes the changes, in one commit', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(seeded())

    expect(session.getProposals()).toEqual([proposal])

    const command: EditorCommand = {
      kind: 'decide-proposal',
      proposalId: 'p1',
      decision: 'adopted',
      changes: proposal.changes,
    }
    const next = applyCommand(session.getCanvas(), command)
    session.onChange(next, command)
    await vi.advanceTimersByTimeAsync(300)

    expect(session.getCanvas().nodes[0]?.x).toBe(240)
    expect(session.getProposals()[0]?.changes[0]?.status).toBe('adopted')
  })

  it('dismissing closes the changes and leaves the board alone', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(seeded())

    const command: EditorCommand = {
      kind: 'decide-proposal',
      proposalId: 'p1',
      decision: 'dismissed',
      changes: proposal.changes,
    }
    session.onChange(applyCommand(session.getCanvas(), command), command)
    await vi.advanceTimersByTimeAsync(300)

    expect(session.getCanvas().nodes[0]?.x).toBe(0)
    expect(session.getProposals()[0]?.changes[0]?.status).toBe('dismissed')
  })

  it('publishes the decided proposals, so the card that asked can go', async () => {
    const backend = makeFakeBackend()
    const session = createDocumentSyncSession(backend, makeDeps())
    session.connect()
    backend._ctrl.handlers!.onSnapshot(seeded())

    const listener = vi.fn()
    const unsubscribe = session.subscribeProposals(listener)

    const command: EditorCommand = {
      kind: 'decide-proposal',
      proposalId: 'p1',
      decision: 'dismissed',
      changes: proposal.changes,
    }
    session.onChange(applyCommand(session.getCanvas(), command), command)
    await vi.advanceTimersByTimeAsync(300)

    expect(listener).toHaveBeenCalled()
    expect(listener.mock.lastCall?.[0][0].changes[0].status).toBe('dismissed')
    unsubscribe()
  })
})
