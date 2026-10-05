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
import type { DocListener, SseStreamSource } from './sse-stream-hub.js'
import { flush } from './test-utils/flush.js'

const BASE = 'http://127.0.0.1:3099'
const REFUSAL_BODY = {
  error: 'markdown_too_large',
  message: 'This update would make a document body 300000 characters long',
}

function handlersRecording() {
  const snapshots: number[][] = []
  const updates: number[][] = []
  const refusals: SyncWriteRefusal[] = []
  const handlers = {
    onSnapshot: (b: Uint8Array) => snapshots.push([...b]),
    onRemoteUpdate: (b: Uint8Array) => updates.push([...b]),
    onConnected: () => {},
    onVersionCreated: () => {},
    onRestoreStarted: () => {},
    onRestoreComplete: () => {},
    onViewportRequest: () => {},
    onWriteRefused: (refusal: SyncWriteRefusal) => refusals.push(refusal),
  } satisfies DocumentBackendHandlers
  return { handlers, snapshots, updates, refusals }
}

/** The daemon, answering each update POST with `status` and `body`. */
function daemonAnswering(status: number, body: unknown) {
  let snapshotCount = 0
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    if (url.includes('/snapshot')) {
      snapshotCount += 1
      return new Response(new Uint8Array([snapshotCount]), { status: 200 })
    }
    if (url.includes('/api/sync/stream')) return new Response(new ReadableStream(), { status: 200 })
    if (url.includes('/update') && init?.method === 'POST') {
      return new Response(JSON.stringify(body), { status })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
  return { transport: { fetch: fetch as unknown as typeof globalThis.fetch } }
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

  it.each([503, 429])('leaves a %i to the caller as a write to retry', async (status) => {
    const daemon = daemonAnswering(status, { error: 'busy', message: 'later' })
    const r = handlersRecording()
    const backend = new SseBackend('ws-1', 'notes', BASE, daemon.transport)
    backend.connect(r.handlers)
    await vi.waitFor(() => expect(r.snapshots).toHaveLength(1))

    await expect(backend.pushLocalUpdate(new Uint8Array([4, 5]))).rejects.toThrow(
      `update refused: ${status}`,
    )
    await flush()
    expect(r.refusals).toEqual([])
    expect(r.snapshots).toHaveLength(1)
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
})
