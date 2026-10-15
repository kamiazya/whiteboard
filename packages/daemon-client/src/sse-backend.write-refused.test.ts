// @vitest-environment node
/**
 * A write the keeper refused for what its bytes would do. Sending the same
 * bytes again gets the same answer, and every later edit is built on them, so
 * a backend that kept offering them would leave everything typed afterwards
 * unsaved — the page has to take the keeper's state instead, and be told why.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SyncWriteRefusal } from './api-contracts/sync-write-refusal.js'
import type { DocumentBackendHandlers } from './document-backend-contract.js'
import { SseBackend } from './sse-backend.js'
import { type DocListener, SseStreamHub, type SseStreamSource } from './sse-stream-hub.js'
import { retryDelayMs } from './write-chain.js'

const BASE = 'http://127.0.0.1:3099'
const REFUSAL_BODY = {
  error: 'markdown_too_large',
  message: 'This update would make a document body 300000 characters long',
}

function handlersRecording() {
  const snapshots: number[][] = []
  const updates: number[][] = []
  const refusals: SyncWriteRefusal[] = []
  const writeStates: string[] = []
  const handlers = {
    onSnapshot: (b: Uint8Array) => snapshots.push([...b]),
    onRemoteUpdate: (b: Uint8Array) => updates.push([...b]),
    onConnected: () => {},
    onVersionCreated: () => {},
    onRestoreStarted: () => {},
    onRestoreComplete: () => {},
    onViewportRequest: () => {},
    onWriteRefused: (refusal: SyncWriteRefusal) => refusals.push(refusal),
    onError: (reason: string) => writeStates.push(reason),
    onWritesLanded: () => writeStates.push('landed'),
  } satisfies DocumentBackendHandlers
  return { handlers, snapshots, updates, refusals, writeStates }
}

/**
 * The daemon, answering update POSTs with `status` and `body` (a function
 * builds a raw body) — every one, or only the first `failFirst`, after which
 * it takes them. `taken` holds each accepted body's bytes, in order.
 */
function daemonAnswering(status: number, body: unknown, failFirst = Number.POSITIVE_INFINITY) {
  let snapshotCount = 0
  let updatePosts = 0
  const taken: number[][] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    if (url.includes('/snapshot')) {
      snapshotCount += 1
      return new Response(new Uint8Array([snapshotCount]), { status: 200 })
    }
    if (url.includes('/api/sync/stream')) return new Response(new ReadableStream(), { status: 200 })
    if (url.includes('/update') && init?.method === 'POST') {
      updatePosts += 1
      if (updatePosts > failFirst) {
        taken.push([...new Uint8Array(init.body as ArrayBuffer)])
        return new Response('{}', { status: 200 })
      }
      const raw = typeof body === 'function' ? (body as () => BodyInit)() : JSON.stringify(body)
      return new Response(raw, { status })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
  return {
    transport: { fetch: fetch as unknown as typeof globalThis.fetch },
    taken,
    attempts: () => updatePosts,
  }
}

describe('SseBackend pushing straight to the daemon', () => {
  it('takes the keeper state and reports the code when the daemon refuses the bytes', async () => {
    const daemon = daemonAnswering(413, REFUSAL_BODY)
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, daemon.transport)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toEqual([[1]]))

    // Resolves: the refusal is answered here, by recovering, not left to the
    // caller as a failure it would retry.
    await backend.pushLocalUpdate(new Uint8Array([4, 5]))

    expect(r.refusals).toEqual([{ code: 'markdown_too_large', message: REFUSAL_BODY.message }])
    await vi.waitFor(() => expect(r.snapshots).toEqual([[1], [2]]))
    backend.disconnect()
  })

  it('reports a refusal whose code it does not know, with the keeper sentence', async () => {
    const daemon = daemonAnswering(400, { error: 'newer_rule', message: 'A newer rule' })
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, daemon.transport)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(1))

    await backend.pushLocalUpdate(new Uint8Array([4, 5]))

    expect(r.refusals).toEqual([{ code: null, message: 'A newer rule' }])
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(2))
    backend.disconnect()
  })

  it.each([
    503, 429,
  ])('sends a write the daemon answered %i again until it lands', async (status) => {
    const daemon = daemonAnswering(status, { error: 'busy', message: 'later' }, 1)
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, daemon.transport)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(1))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pushed = backend.pushLocalUpdate(new Uint8Array([4, 5]))
      await vi.advanceTimersByTimeAsync(0)
      expect(r.writeStates).toEqual(['storage-failure'])
      expect(daemon.taken).toEqual([])

      await vi.advanceTimersByTimeAsync(1000)
      await pushed
      expect(daemon.taken).toEqual([[4, 5]])
      expect(r.writeStates).toEqual(['storage-failure', 'landed'])
      // Never taken for a refusal of the bytes: nothing is dropped.
      expect(r.refusals).toEqual([])
      expect(r.snapshots).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      backend.disconnect()
    }
  })

  it('waits as long as the daemon asked before sending again', async () => {
    let posts = 0
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/snapshot')) return new Response(new Uint8Array([1]), { status: 200 })
      if (url.includes('/api/sync/stream'))
        return new Response(new ReadableStream(), { status: 200 })
      if (url.includes('/update') && init?.method === 'POST') {
        posts += 1
        if (posts === 1) return new Response('{}', { status: 503, headers: { 'Retry-After': '5' } })
      }
      return new Response('{}', { status: 200 })
    })
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, {
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(1))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      void backend.pushLocalUpdate(new Uint8Array([4, 5]))
      await vi.advanceTimersByTimeAsync(4999)
      expect(posts).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(posts).toBe(2)
      expect(r.writeStates).toEqual(['storage-failure', 'landed'])
    } finally {
      vi.useRealTimers()
      backend.disconnect()
    }
  })

  it('sends the writes queued behind a failed one in order, after it', async () => {
    const daemon = daemonAnswering(503, { error: 'busy', message: 'later' }, 1)
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, daemon.transport)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(1))

    const first = backend.pushLocalUpdate(new Uint8Array([1]))
    const second = backend.pushLocalUpdate(new Uint8Array([2]))
    await Promise.all([first, second])

    // The second write carried the first: a write that lands never skips one
    // still outstanding before it.
    expect(daemon.taken).toEqual([[1], [2]])
    expect(r.writeStates).toEqual(['storage-failure', 'landed'])
    backend.disconnect()
  })

  it('drops the writes still queued when it disconnects, rather than settling them as landed', async () => {
    const daemon = daemonAnswering(503, { error: 'busy', message: 'later' })
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, daemon.transport)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(1))

    const pushed = backend.pushLocalUpdate(new Uint8Array([4, 5]))
    await vi.waitFor(() => expect(r.writeStates).toEqual(['storage-failure']))
    backend.disconnect()
    await expect(pushed).rejects.toThrow('writer closed')
    expect(daemon.taken).toEqual([])
  })
})

describe('SseBackend through an injected source that writes straight to the daemon', () => {
  // Who retries is decided by what the source's push answers, not by whether
  // a source was injected: a hub shared by the page leaves this backend
  // holding the only copy of a write the daemon did not take.
  it('sends a write the daemon answered 503 again until it lands', async () => {
    const daemon = daemonAnswering(503, { error: 'busy', message: 'later' }, 1)
    const r = handlersRecording()
    const hub = new SseStreamHub({ fetch: daemon.transport.fetch, baseUrl: BASE })
    const backend = new SseBackend('ws-1', 'notes', BASE, undefined, hub)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(1))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pushed = backend.pushLocalUpdate(new Uint8Array([4, 5]))
      await vi.advanceTimersByTimeAsync(0)
      expect(r.writeStates).toEqual(['storage-failure'])
      expect(daemon.attempts()).toBe(1)

      await vi.advanceTimersByTimeAsync(retryDelayMs(1))
      await pushed
      expect(daemon.attempts()).toBe(2)
      expect(daemon.taken).toEqual([[4, 5]])
      expect(r.writeStates).toEqual(['storage-failure', 'landed'])
    } finally {
      vi.useRealTimers()
      backend.disconnect()
      hub.close()
    }
  })
})

describe('SseBackend through a source that writes onward itself', () => {
  function sourceWithHeldSnapshot() {
    const listeners: DocListener[] = []
    let answer: (bytes: Uint8Array) => void = () => {}
    let snapshots = 0
    const source: SseStreamSource = {
      subscribe: (_doc, listener) => {
        listeners.push(listener)
        return () => {}
      },
      sendMessage: () => {},
      push: () => {},
      snapshot: () => {
        snapshots += 1
        if (snapshots === 1) return Promise.resolve(new Uint8Array([1]))
        return new Promise((resolve) => {
          answer = resolve
        })
      },
    }
    return { source, listeners, answer: (bytes: Uint8Array) => answer(bytes) }
  }

  it('takes the source state, with the frames that arrived while it was asked for', async () => {
    const s = sourceWithHeldSnapshot()
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, undefined, s.source)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(s.listeners.length).toBeGreaterThan(0))

    const refusal = { code: 'node_text_too_large', message: 'too long' } as const
    for (const l of s.listeners) l.onWriteRefused?.(refusal)
    expect(r.refusals).toEqual([refusal])

    // A frame that lands before the new state does belongs AFTER it: applied
    // to the copy about to be replaced, it would be lost with it.
    for (const l of s.listeners) l.onUpdate([9] as unknown as Uint8Array)
    expect(r.updates).toEqual([])
    s.answer(new Uint8Array([2]))
    await vi.waitFor(() => expect(r.snapshots).toEqual([[1], [2]]))
    expect(r.updates).toEqual([[9]])
    backend.disconnect()
  })

  it('delivers frames that arrive after the keeper state was taken', async () => {
    const s = sourceWithHeldSnapshot()
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, undefined, s.source)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(s.listeners.length).toBeGreaterThan(0))
    for (const l of s.listeners)
      l.onWriteRefused?.({ code: 'node_text_too_large', message: 'too long' })
    s.answer(new Uint8Array([2]))
    await vi.waitFor(() => expect(r.snapshots).toEqual([[1], [2]]))

    // Holding ends with the resync: a frame held past it is swallowed, and
    // every later edit from another writer never reaches this copy.
    for (const l of s.listeners) l.onUpdate([10] as unknown as Uint8Array)
    expect(r.updates).toEqual([[10]])
    backend.disconnect()
  })

  it('treats a refusal whose body is cut mid-read as the network, sending the bytes again', async () => {
    const cut = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'))
          controller.error(new TypeError('network error'))
        },
      })
    const daemon = daemonAnswering(413, cut, 1)
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, daemon.transport)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(1))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pushed = backend.pushLocalUpdate(new Uint8Array([4, 5]))
      await vi.advanceTimersByTimeAsync(1000)
      await pushed
      expect(r.refusals).toEqual([])
      expect(r.snapshots).toHaveLength(1)
      expect(daemon.taken).toEqual([[4, 5]])
      expect(r.writeStates).toEqual(['storage-failure', 'landed'])
    } finally {
      vi.useRealTimers()
      backend.disconnect()
    }
  })
})
