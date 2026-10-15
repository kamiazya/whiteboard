// @vitest-environment node
/**
 * An open whose stream does not carry the workspace. The backend reads the
 * keeper's state once the stream does — but a stream that never does must
 * not leave the caller with no document, so the read also runs on a refusal
 * and once `UNROUTED_OPEN_MS` passes, and the routing that follows catches
 * up instead of opening again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentBackendHandlers } from './document-backend-contract.js'
import { SseBackend, UNROUTED_OPEN_MS } from './sse-backend.js'
import type { DocListener, SseStreamSource } from './sse-stream-hub.js'
import { flush } from './test-utils/flush.js'

const BASE = 'http://127.0.0.1:3099'
const WORKSPACE_KEY = 'workspace:ws-1'

/** A source that joins every subscriber unrouted and answers each snapshot when told to. */
function heldSource() {
  const listeners: DocListener[] = []
  const pending: ((bytes: Uint8Array) => void)[] = []
  const source: SseStreamSource = {
    subscribe: (doc, listener) => {
      if (doc === WORKSPACE_KEY) listeners.push(listener)
      listener.onConnectionChange?.(false)
      return () => {}
    },
    sendMessage: () => {},
    push: () => {},
    snapshot: () =>
      new Promise((resolve) => {
        pending.push(resolve)
      }),
  }
  return {
    source,
    pending,
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
})
