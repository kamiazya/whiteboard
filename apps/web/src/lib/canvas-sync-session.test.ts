/**
 * canvas-sync-session unit tests — jsdom layer.
 *
 * Exercises the session module directly (no React, no Excalidraw) against a
 * fake CanvasBackend and SpatialCanvas/EditorCommand fixtures — the
 * document-shaped surface this session now owns.
 */

import {
  readSpatialCanvas,
  setNodeLock,
  writeSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type {
  CanvasBackend,
  CanvasBackendHandlers,
} from '@kamiazya/whiteboard-mcp/browser-contract'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { applyCommand } from '../components/spatial-editor/commands.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'

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
  createCanvasSyncSession,
  createGenerationCounters,
  type SessionDeps,
} from './canvas-sync-session.js'

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
  handlers: CanvasBackendHandlers | null
  disconnectCalled: boolean
  pushLocalUpdateCalls: Uint8Array[]
  /** Models a transport that is down: pushes are accepted and discarded,
   *  which is what DaemonBackend does when its socket is not OPEN. */
  transportDown: boolean
}

function makeFakeBackend(): CanvasBackend & { _ctrl: FakeBackendControl } {
  const ctrl: FakeBackendControl = {
    handlers: null,
    disconnectCalled: false,
    pushLocalUpdateCalls: [],
    transportDown: false,
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

describe('createCanvasSyncSession', () => {
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
    const session = createCanvasSyncSession(backend, makeDeps({ onStatusChange }))

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
    const session = createCanvasSyncSession(backend, makeDeps())
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

  it('hydrates via readSpatialCanvas on snapshot and publishes it to subscribers', () => {
    const backend = makeFakeBackend()
    const session = createCanvasSyncSession(backend, makeDeps())
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

  it('onChange with a move-node command writes only that node into doc.getMap("nodes"), leaving a peer edit to the sibling node intact after merge', async () => {
    const backend = makeFakeBackend()
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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

  it('debounce coalescing: create-node then move-node for the same id dedupes to a single write of the final node value', async () => {
    const backend = makeFakeBackend()
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    // mode the comment in createCanvasSyncSession warns about.
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
    const sessionA = createCanvasSyncSession(backendA, makeDeps({ generations }))
    sessionA.connect()
    backendA._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))

    const command: EditorCommand = { kind: 'move-node', id: 'n-a', x: 1, y: 1 }
    sessionA.onChange(applyCommand(twoNodeCanvas(), command), command)

    // Before the 300ms debounce fires, session A is disposed and a new
    // session B is constructed against a different backend/doc.
    sessionA.dispose()
    const sessionB = createCanvasSyncSession(backendB, makeDeps({ generations }))
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
    session.connect()

    // No snapshot has landed yet — onEditorReady must still send clientReady.
    session.onEditorReady()
    expect(sendReadySpy).toHaveBeenCalledTimes(2) // once on connect, once on ready
  })

  it('restore lifecycle drives the injected restore callback and clears undo on complete', () => {
    const backend = makeFakeBackend()
    const onRestoreChange = vi.fn()
    const session = createCanvasSyncSession(backend, makeDeps({ onRestoreChange }))
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
    const backend: CanvasBackend & { _ctrl: FakeBackendControl } = {
      ...makeFakeBackend(),
      pushLocalUpdate(_bytes) {
        callOrder.push('push-called')
        return new Promise(() => {}) // never settles — disconnect must not wait for this
      },
      disconnect() {
        callOrder.push('disconnect')
      },
    }
    const session = createCanvasSyncSession(backend, makeDeps())
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
    const session = createCanvasSyncSession(backend, makeDeps())
    session.connect()

    session.dispose()

    expect(backend._ctrl.disconnectCalled).toBe(true)
  })

  it('onAuthError sets error status and invokes options.onAuthError via getOptions', () => {
    const backend = makeFakeBackend()
    const onStatusChange = vi.fn()
    const onAuthError = vi.fn()
    const session = createCanvasSyncSession(
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
          const session = createCanvasSyncSession(backend, makeDeps())
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
        const session = createCanvasSyncSession(backend, makeDeps())
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
      const session = createCanvasSyncSession(backend, makeDeps())
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
      const session = createCanvasSyncSession(backend, makeDeps())
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
      const session = createCanvasSyncSession(backend, makeDeps())
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

  // Node lock lives in the doc's sidecar map, so it must survive the same
  // reload path a canvas does — and the CONSUMER only learns about it
  // through subscribeLocks, which is why hydration has to notify.
  describe('node lock', () => {
    it('hydration reports the persisted lock set, not an empty one (reload regression)', () => {
      const backend = makeFakeBackend()
      const session = createCanvasSyncSession(backend, makeDeps())
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
      const session = createCanvasSyncSession(backend, makeDeps())
      session.connect()
      backend._ctrl.handlers!.onSnapshot(makeSnapshot(twoNodeCanvas()))
      const before = backend._ctrl.pushLocalUpdateCalls.length

      const canvasListener = vi.fn()
      session.subscribe(canvasListener)
      const lockListener = vi.fn()
      session.subscribeLocks(lockListener)

      session.setNodeLock('n-b', true)
      await vi.advanceTimersByTimeAsync(300)

      expect(session.getNodeLocks()).toEqual(new Set(['n-b']))
      expect(lockListener).toHaveBeenCalled()
      // The lock reaches peers...
      expect(backend._ctrl.pushLocalUpdateCalls.length).toBeGreaterThan(before)
      // ...but it is not canvas content, so no canvas publish fires.
      expect(canvasListener).not.toHaveBeenCalled()
    })
  })
})
