// @vitest-environment node
/**
 * An open whose stream does not carry the workspace. The backend reads the
 * keeper's state once the stream does — but a stream that never does must
 * not leave the caller with no document, so the read also runs on a refusal
 * and once `UNROUTED_OPEN_MS` passes, and the routing that follows catches
 * up instead of opening again — unless that read delivered nothing, when it
 * opens again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentBackendHandlers } from './document-backend-contract.js'
import { SseBackend, UNROUTED_OPEN_MS } from './sse-backend.js'
import type { DocListener, SseStreamSource } from './sse-stream-hub.js'
import { flush } from './test-utils/flush.js'

const BASE = 'http://127.0.0.1:3099'
const WORKSPACE_KEY = 'workspace:ws-1'

/** A source that joins every subscriber unrouted and answers, or fails, each snapshot when told to. */
function heldSource() {
  const listeners: DocListener[] = []
  const pending: ((bytes: Uint8Array | null) => void)[] = []
  const failing: ((reason: Error) => void)[] = []
  const source: SseStreamSource = {
    subscribe: (doc, listener) => {
      if (doc === WORKSPACE_KEY) listeners.push(listener)
      listener.onConnectionChange?.(false)
      return () => {}
    },
    sendMessage: () => {},
    push: () => {},
    snapshot: () =>
      new Promise((resolve, reject) => {
        pending.push(resolve)
        failing.push(reject)
      }),
  }
  return {
    source,
    pending,
    failing,
    routing: (connected: boolean) => {
      for (const l of listeners) l.onConnectionChange?.(connected)
    },
  }
}

function recording() {
  const order: string[] = []
  const handlers: DocumentBackendHandlers = {
    onSnapshot: (b) => order.push(`snapshot ${b[0]}`),
    onRemoteUpdate: (b) => order.push(`update ${b[0]}`),
    onConnected: () => order.push('connected'),
    onDisconnected: () => order.push('disconnected'),
    onVersionCreated: () => {},
    onRestoreStarted: () => {},
    onRestoreComplete: () => {},
    onViewportRequest: () => {},
  }
  return { order, handlers }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SseBackend opening a document its stream does not carry', () => {
  it('reads the keeper state once the bound on routing passes, and not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)

    await vi.advanceTimersByTimeAsync(UNROUTED_OPEN_MS - 1)
    expect(s.pending).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.pending).toHaveLength(1)

    s.pending[0]?.(new Uint8Array([1]))
    await flush()
    // Loaded, and not claimed live: nothing carries the keeper's writes yet.
    expect(r.order).toEqual(['disconnected', 'snapshot 1'])
    backend.disconnect()
  })

  it('reads the keeper state at once when the source refuses the document', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    expect(s.pending).toHaveLength(0)

    s.routing(false)
    expect(s.pending).toHaveLength(1)
    // And the bound passing later reads nothing more.
    await vi.advanceTimersByTimeAsync(UNROUTED_OPEN_MS)
    expect(s.pending).toHaveLength(1)
    backend.disconnect()
  })

  it('catches up by merging when the routing arrives after an unrouted read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    s.routing(false)
    s.pending[0]?.(new Uint8Array([1]))
    await flush()

    s.routing(true)
    expect(s.pending).toHaveLength(2)
    s.pending[1]?.(new Uint8Array([2]))
    await flush()

    // Merged, never replacing: the caller keeps its document and its undo.
    // Connected at the routing, as after a reconnect: it has a copy already.
    expect(r.order).toEqual(['disconnected', 'disconnected', 'snapshot 1', 'connected', 'update 2'])
    backend.disconnect()
  })

  it('merges a catch-up that settles first only after the unrouted read it overlaps', async () => {
    // The routing arrives while the unrouted read is still in flight. Its
    // catch-up settling first and merging at once would be replaced by the
    // older snapshot settling after it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    s.routing(false)
    s.routing(true)
    expect(s.pending).toHaveLength(2)

    s.pending[1]?.(new Uint8Array([2]))
    await flush()
    expect(r.order).not.toContain('update 2')
    s.pending[0]?.(new Uint8Array([1]))
    await flush()

    expect(r.order.filter((c) => c !== 'disconnected')).toEqual([
      'snapshot 1',
      'update 2',
      'connected',
    ])
    backend.disconnect()
  })

  it('reads once when the routing arrives inside the bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    s.routing(true)
    s.pending[0]?.(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(UNROUTED_OPEN_MS * 2)

    expect(s.pending).toHaveLength(1)
    expect(r.order).toEqual(['disconnected', 'snapshot 1', 'connected'])
    backend.disconnect()
  })

  it('reads nothing once disconnected inside the bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(recording().handlers)
    backend.disconnect()
    await vi.advanceTimersByTimeAsync(UNROUTED_OPEN_MS * 2)

    expect(s.pending).toHaveLength(0)
  })

  it('opens on the routing that follows an unrouted read that failed', async () => {
    // A daemon restarting, or a proxy's passing 5xx, inside the bound. The
    // caller still has no document, so the routing must hand it one to
    // replace with — a merge into nothing is dropped, and the page never opens.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    await vi.advanceTimersByTimeAsync(UNROUTED_OPEN_MS)
    s.failing[0]?.(new Error('snapshot refused: 503'))
    await flush()
    expect(r.order).toEqual(['disconnected'])

    s.routing(true)
    expect(s.pending).toHaveLength(2)
    s.pending[1]?.(new Uint8Array([2]))
    await flush()

    expect(r.order).toEqual(['disconnected', 'snapshot 2', 'connected'])
    backend.disconnect()
  })

  it('reads again after a routed opening read fails, and reports the connection only then', async () => {
    // Routed, so no later routing will come to retry it: the open does.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    s.routing(true)
    s.failing[0]?.(new Error('snapshot refused: 503'))
    await flush()
    expect(r.order).toEqual(['disconnected'])

    await vi.advanceTimersByTimeAsync(UNROUTED_OPEN_MS)
    expect(s.pending).toHaveLength(2)
    s.pending[1]?.(new Uint8Array([3]))
    await flush()

    expect(r.order).toEqual(['disconnected', 'snapshot 3', 'connected'])
    backend.disconnect()
  })

  it('does not read a replacing snapshot again on a drop after a delivered open', async () => {
    // A second replacing read swaps the caller's copy, and its undo history
    // with it, at every blip; the re-routing catches up by merging instead.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    s.routing(true)
    s.pending[0]?.(new Uint8Array([1]))
    await flush()

    s.routing(false)
    s.routing(true)
    for (const answer of s.pending.slice(1)) answer(new Uint8Array([2]))
    await flush()

    expect(s.pending).toHaveLength(2)
    expect(r.order).toEqual([
      'disconnected',
      'snapshot 1',
      'connected',
      'disconnected',
      'connected',
      'update 2',
    ])
    backend.disconnect()
  })

  it('opens again after a failed read, a drop and a re-routing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    s.routing(true)
    s.failing[0]?.(new Error('snapshot refused: 503'))
    await flush()

    s.routing(false)
    // The drop itself opens again: the read it starts is the replacing one.
    expect(s.pending).toHaveLength(2)
    s.routing(true)
    for (const answer of s.pending.slice(1)) answer(new Uint8Array([4]))
    await flush()

    // The drop opens; the re-routing catches up on what that read may have missed.
    expect(r.order.filter((c) => c !== 'disconnected')).toEqual([
      'snapshot 4',
      'update 4',
      'connected',
    ])
    backend.disconnect()
  })

  it('opens on a re-routing when the read the drop started failed too', async () => {
    // The keeper still away when the stream drops: the drop's read fails like
    // the first, and the re-routing is the next chance to open.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    s.routing(true)
    s.failing[0]?.(new Error('snapshot refused: 503'))
    await flush()
    s.routing(false)
    s.failing[1]?.(new Error('fetch failed'))
    await flush()

    s.routing(true)
    expect(s.pending).toHaveLength(3)
    s.pending[2]?.(new Uint8Array([6]))
    await flush()

    expect(r.order.filter((c) => c !== 'disconnected')).toEqual(['snapshot 6', 'connected'])
    backend.disconnect()
  })

  it('reads again after an opening read answered empty', async () => {
    // A SharedWorker whose own read of the keeper failed answers empty, never
    // an empty document a scoped caller would report as corrupt.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    s.routing(true)
    s.pending[0]?.(new Uint8Array())
    await flush()
    expect(r.order).toEqual(['disconnected'])

    await vi.advanceTimersByTimeAsync(UNROUTED_OPEN_MS)
    s.pending[1]?.(new Uint8Array([5]))
    await flush()

    expect(r.order).toEqual(['disconnected', 'snapshot 5', 'connected'])
    backend.disconnect()
  })

  it('does not read again once the keeper said it does not know the document', async () => {
    // `null` is an answer, not a failure: asking again answers the same.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = heldSource()
    const r = recording()
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, undefined, s.source)
    backend.connect(r.handlers)
    s.routing(true)
    s.pending[0]?.(null)
    await vi.advanceTimersByTimeAsync(UNROUTED_OPEN_MS * 2)

    expect(s.pending).toHaveLength(1)
    expect(r.order).toEqual(['disconnected', 'connected'])
    backend.disconnect()
  })
})
