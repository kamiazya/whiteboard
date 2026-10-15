// @vitest-environment node
/**
 * A write the keeper refused for what its bytes would do. Sending the same
 * bytes again gets the same answer, and every later edit is built on them, so
 * a backend that kept offering them would leave everything typed afterwards
 * unsaved — the page has to take the keeper's state instead, and be told why.
 */
import { describe, expect, it, vi } from 'vitest'
import { type SyncWriteRefusal, SyncWriteRefusedError } from './api-contracts/sync-write-refusal.js'
import type { DocumentBackendHandlers } from './document-backend-contract.js'
import { SseBackend } from './sse-backend.js'
import { type DocListener, SseStreamHub, type SseStreamSource } from './sse-stream-hub.js'
import { retryDelayMs } from './write-chain.js'

const BASE = 'http://127.0.0.1:3099'

/**
 * A stream that opens and stays open. The backend reads the keeper's state
 * only once the stream carries the document, so a stream that never says
 * `ready` would leave every case waiting on a snapshot that never comes.
 */
function openStream(): Response {
  const ready = new TextEncoder().encode('event: ready\ndata: {"streamId":"s-1"}\n\n')
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(ready)
      },
    }),
    { status: 200 },
  )
}
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
    if (url.includes('/api/sync/stream')) return openStream()
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
      if (url.includes('/api/sync/stream')) return openStream()
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

describe('SseBackend disconnected while its own write is failing', () => {
  // The page that would read either signal is gone, and a retry outliving the
  // backend would send an edit the session has already been told was dropped.
  it('sends nothing again and reports nothing more', async () => {
    const daemon = daemonAnswering(503, { error: 'busy', message: 'later' }, 1)
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, daemon.transport)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(1))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let outcome = 'pending'
      void Promise.resolve(backend.pushLocalUpdate(new Uint8Array([4]))).then(
        () => {
          outcome = 'landed'
        },
        (err: Error) => {
          outcome = err.message
        },
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(r.writeStates).toEqual(['storage-failure'])
      backend.disconnect()

      await vi.advanceTimersByTimeAsync(retryDelayMs(1))
      expect(daemon.attempts()).toBe(1)
      expect(outcome).toBe('writer closed')
      expect(r.writeStates).toEqual(['storage-failure'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SseBackend disconnecting with writes outstanding', () => {
  // A document switch disconnects the moment the last edit is handed over,
  // often while the one before it is still on the wire: the queued edit is
  // the person's last, and no page is left to say it was not saved.
  it('sends a write queued behind one in flight', async () => {
    let answerFirst: () => void = () => {}
    const posted: number[][] = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/snapshot')) return new Response(new Uint8Array([1]), { status: 200 })
      if (url.includes('/api/sync/stream')) return openStream()
      if (url.includes('/update') && init?.method === 'POST') {
        posted.push([...new Uint8Array(init.body as ArrayBuffer)])
        if (posted.length === 1) await new Promise<void>((r) => (answerFirst = r))
      }
      return new Response('{}', { status: 200 })
    })
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, {
      fetch: fetch as unknown as typeof globalThis.fetch,
    })
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(1))

    const first = backend.pushLocalUpdate(new Uint8Array([1]))
    await vi.waitFor(() => expect(posted).toEqual([[1]]))
    const last = backend.pushLocalUpdate(new Uint8Array([2]))
    backend.disconnect()
    answerFirst()

    await Promise.all([first, last])
    expect(posted).toEqual([[1], [2]])
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

describe('SseBackend through an injected source whose push the daemon refuses', () => {
  // The refused bytes will be refused every time, so the page is told why and
  // continues from the keeper's state — the write settles rather than
  // rejecting, which would put the session in error over a recovery.
  it('settles the write, reports the refusal, and takes the keeper state', async () => {
    let snapshots = 0
    const refusal = { code: 'node_text_too_large', message: 'too long' } as const
    const source: SseStreamSource = {
      subscribe: (_doc, listener) => {
        listener.onConnectionChange?.(true)
        return () => {}
      },
      sendMessage: () => {},
      push: () => Promise.reject(new SyncWriteRefusedError(413, refusal)),
      snapshot: () => {
        snapshots += 1
        return Promise.resolve(new Uint8Array([snapshots]))
      },
    }
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, undefined, source)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toEqual([[1]]))

    await expect(backend.pushLocalUpdate(new Uint8Array([4]))).resolves.toBeUndefined()
    expect(r.refusals).toEqual([refusal])
    await vi.waitFor(() => expect(r.snapshots).toEqual([[1], [2]]))
    expect(r.writeStates).toEqual([])
    backend.disconnect()
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
        listener.onConnectionChange?.(true)
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

  it('holds a frame until every overlapping keeper-state read has settled', async () => {
    // Two reads in flight, the later settling first: a frame released then
    // reaches a copy the earlier read's snapshot is about to replace.
    const listeners: DocListener[] = []
    const pending: ((bytes: Uint8Array) => void)[] = []
    let reads = 0
    const source: SseStreamSource = {
      subscribe: (_doc, listener) => {
        listeners.push(listener)
        listener.onConnectionChange?.(true)
        return () => {}
      },
      sendMessage: () => {},
      push: () => {},
      snapshot: () =>
        ++reads === 1
          ? Promise.resolve(new Uint8Array([1]))
          : new Promise((resolve) => {
              pending.push(resolve)
            }),
    }
    const order: string[] = []
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, undefined, source)
    backend.connect({
      ...r.handlers,
      onSnapshot: (b) => order.push(`snapshot ${b[0]}`),
      onRemoteUpdate: (b) => order.push(`update ${b[0]}`),
    })
    await vi.waitFor(() => expect(listeners.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(order).toEqual(['snapshot 1']))

    const refusal = { code: 'node_text_too_large', message: 'too long' } as const
    for (const l of listeners) l.onWriteRefused?.(refusal)
    for (const l of listeners) l.onWriteRefused?.(refusal)
    await vi.waitFor(() => expect(pending).toHaveLength(2))

    pending[1]?.(new Uint8Array([3]))
    await vi.waitFor(() => expect(order).toEqual(['snapshot 1', 'snapshot 3']))
    for (const l of listeners) l.onUpdate([9] as unknown as Uint8Array)
    pending[0]?.(new Uint8Array([2]))

    await vi.waitFor(() =>
      expect(order).toEqual(['snapshot 1', 'snapshot 3', 'snapshot 2', 'update 9']),
    )
    backend.disconnect()
  })

  it('keeps a frame an earlier keeper-state read holds when a later read starts', async () => {
    // The frame arrives between the two reads starting. A later read that
    // started a fresh queue would drop it: the earlier read's snapshot then
    // replaces the copy last, and the frame that followed it is gone.
    const listeners: DocListener[] = []
    const pending: ((bytes: Uint8Array) => void)[] = []
    let reads = 0
    const source: SseStreamSource = {
      subscribe: (_doc, listener) => {
        listeners.push(listener)
        listener.onConnectionChange?.(true)
        return () => {}
      },
      sendMessage: () => {},
      push: () => {},
      snapshot: () =>
        ++reads === 1
          ? Promise.resolve(new Uint8Array([1]))
          : new Promise((resolve) => {
              pending.push(resolve)
            }),
    }
    const order: string[] = []
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, undefined, source)
    backend.connect({
      ...r.handlers,
      onSnapshot: (b) => order.push(`snapshot ${b[0]}`),
      onRemoteUpdate: (b) => order.push(`update ${b[0]}`),
    })
    await vi.waitFor(() => expect(order).toEqual(['snapshot 1']))

    const refusal = { code: 'node_text_too_large', message: 'too long' } as const
    for (const l of listeners) l.onWriteRefused?.(refusal)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    for (const l of listeners) l.onUpdate(new Uint8Array([8]))
    for (const l of listeners) l.onWriteRefused?.(refusal)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]?.(new Uint8Array([3]))
    pending[0]?.(new Uint8Array([2]))

    await vi.waitFor(() =>
      expect(order).toEqual(['snapshot 1', 'snapshot 3', 'snapshot 2', 'update 8']),
    )
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
