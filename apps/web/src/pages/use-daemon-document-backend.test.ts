/**
 * The rules that decide WHETHER this page has a connection at all, driven
 * directly.
 *
 * Each of them was reachable only by mounting the whole daemon page and
 * arranging the daemon's answers around it — which is why the page's own
 * suite tests what a connection DOES (auth errors, switching) and none of
 * these: that no backend opens while the document list is still loading, that
 * an injected one keeps the per-document contract, and that a path the list
 * does not hold opens nothing rather than minting a blank canvas at a stale
 * URL.
 */
import type { DocumentSummary } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type {
  DocumentBackend,
  DocumentBackendHandlers,
} from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { SseBackend, UNROUTED_OPEN_MS } from '@kamiazya/whiteboard-daemon-client/sse-backend'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL } from '../lib/bridge-address.js'
import { useDaemonDocumentBackend } from './use-daemon-document-backend.js'

// A failed worker is remembered per origin for the module's lifetime, so each
// run that fails one takes an origin of its own.
let failingOrigins = 0

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'
const fetchFn = vi.fn() as unknown as typeof fetch

function summary(path: string, id: string): DocumentSummary {
  return { documentId: id, path, kind: 'spatial', updatedAt: '2026-01-01T00:00:00.000Z' }
}

function options(over: Partial<Parameters<typeof useDaemonDocumentBackend>[0]> = {}) {
  return {
    daemonBaseUrl: DAEMON_BASE_URL,
    daemonFetch: fetchFn,
    workspaceId: 'ws-1',
    path: 'board',
    loading: false,
    documents: [summary('board', 'doc-1')],
    ...over,
  }
}

describe('useDaemonDocumentBackend', () => {
  it('opens nothing while the document list is still loading', () => {
    const { result, rerender } = renderHook((props) => useDaemonDocumentBackend(props), {
      initialProps: options({ loading: true }),
    })
    // The list is what decides the sync granularity, so connecting before it
    // lands would open a per-document socket only to swap it a moment later.
    expect(result.current.backend).toBeNull()

    rerender(options({ loading: false }))
    expect(result.current.backend).not.toBeNull()
    expect(result.current.contentDocumentId).toBe('doc-1')
  })

  it('opens nothing for a path the list does not hold', () => {
    // A stale URL: the document was deleted, or never existed. The old
    // per-document contract answered this with a lazily created empty doc,
    // which minted a blank canvas at that path on the first edit.
    const { result } = renderHook(() => useDaemonDocumentBackend(options({ path: 'gone' })))
    expect(result.current.backend).toBeNull()
    expect(result.current.contentDocumentId).toBeUndefined()
  })

  it('uses an injected backend and gives it no content id', () => {
    const injected = {
      connect() {},
      disconnect() {},
      pushLocalUpdate() {},
      sendClientReady() {},
    } satisfies DocumentBackend
    const { result } = renderHook(() =>
      useDaemonDocumentBackend(options({ createBackend: () => injected })),
    )
    expect(result.current.backend).toBe(injected)
    // An injected backend keeps the per-document contract, so scoping the
    // session against a workspace-document snapshot would misread it.
    expect(result.current.contentDocumentId).toBeUndefined()
  })

  it('keeps one connection across a re-render that only changes the factory identity', () => {
    // A parent writing the natural `createBackend={(w, p) => …}` hands this
    // hook a new function on every one of ITS renders. Re-keying on that
    // would tear the socket down and drop the undo history for a document
    // nobody left.
    //
    // What holds it is the memo's DEPENDENCY LIST, which deliberately omits
    // the factory — measured: reading `createBackend` directly instead of
    // through the ref leaves this green, and adding it to the deps is what
    // turns it red. The ref is how the omission reads as deliberate rather
    // than forgotten, not the guard.
    const first = renderHook((props) => useDaemonDocumentBackend(props), {
      initialProps: options({ createBackend: () => null }),
    })
    const opened = first.result.current.backend
    expect(opened).not.toBeNull()

    first.rerender(options({ createBackend: () => null }))
    expect(first.result.current.backend).toBe(opened)
  })

  it('clears a reported auth refusal when a new connection opens', () => {
    const { result, rerender } = renderHook((props) => useDaemonDocumentBackend(props), {
      initialProps: options(),
    })
    act(() => {
      result.current.reportAuthError()
    })
    expect(result.current.authError).toBe(true)

    // A refusal belongs to one connection; the next one has not been refused.
    rerender(options({ path: 'second', documents: [summary('second', 'doc-2')] }))
    expect(result.current.authError).toBe(false)
  })
})

// ADR-0050: the local daemon's WebSocket goes, so every keeper syncs over
// SSE — the bridge carries only the stream, and a plain-http page reaching a
// plain-http daemon, which used to open a socket, uses it too.
describe('useDaemonDocumentBackend transport', () => {
  it.each([
    ['a daemon reached through the extension', BRIDGE_DAEMON_BASE_URL],
    ['a daemon on loopback, from a plain-http page', DAEMON_BASE_URL],
  ])('syncs over SSE for %s', (_what, daemonBaseUrl) => {
    const { result } = renderHook(() => useDaemonDocumentBackend(options({ daemonBaseUrl })))
    expect(result.current.backend).toBeInstanceOf(SseBackend)
  })
})

/** A SharedWorker that constructs fine and fails to load afterwards, the way a missing chunk does. */
class FailingSharedWorker {
  static instances: FailingSharedWorker[] = []
  onerror: ((event: unknown) => void) | null = null
  readonly port = { postMessage: vi.fn(), start: vi.fn(), onmessage: null }
  constructor() {
    FailingSharedWorker.instances.push(this)
  }
  fail() {
    this.onerror?.({ message: 'chunk failed to load' })
  }
}

function snapshotHandlers(onSnapshot: (bytes: Uint8Array) => void): DocumentBackendHandlers {
  return {
    onSnapshot,
    onRemoteUpdate: () => {},
    onConnected: () => {},
    onVersionCreated: () => {},
    onRestoreStarted: () => {},
    onRestoreComplete: () => {},
    onViewportRequest: () => {},
  }
}

describe('useDaemonDocumentBackend when the shared worker fails to load', () => {
  const originalSharedWorker = globalThis.SharedWorker
  afterEach(() => {
    vi.useRealTimers()
    globalThis.SharedWorker = originalSharedWorker
  })

  it('keeps its connection, and the page opens from its own read', async () => {
    vi.useFakeTimers()
    FailingSharedWorker.instances = []
    globalThis.SharedWorker = FailingSharedWorker as unknown as typeof SharedWorker
    // Every snapshot read answers; the stream itself never does, so the open
    // can only come from the unrouted-open read.
    const daemonFetch = vi.fn((input: RequestInfo | URL) =>
      String(input).endsWith('/snapshot')
        ? Promise.resolve(new Response(new Uint8Array([7])))
        : new Promise<Response>(() => {}),
    ) as unknown as typeof fetch
    const daemonBaseUrl = `http://worker-fails-${++failingOrigins}.test`
    const { result } = renderHook(() =>
      useDaemonDocumentBackend(options({ daemonBaseUrl: daemonBaseUrl, daemonFetch })),
    )
    const onTheWorker = result.current.backend
    const onSnapshot = vi.fn()
    onTheWorker?.connect(snapshotHandlers(onSnapshot))
    expect(FailingSharedWorker.instances).toHaveLength(1)

    act(() => FailingSharedWorker.instances[0]?.fail())
    // The source falls back inside itself, so the page has nothing to rebuild.
    expect(result.current.backend).toBe(onTheWorker)
    await act(() => vi.advanceTimersByTimeAsync(UNROUTED_OPEN_MS))

    expect(onSnapshot).toHaveBeenCalledWith(new Uint8Array([7]))
    expect(FailingSharedWorker.instances).toHaveLength(1)
    onTheWorker?.disconnect()
  })
})
