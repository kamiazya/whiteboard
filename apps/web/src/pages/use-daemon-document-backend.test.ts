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
import type { DocumentBackend } from '@kamiazya/whiteboard-daemon-client/document-backend-contract'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDaemonDocumentBackend } from './use-daemon-document-backend.js'

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'
const fetchFn = vi.fn() as unknown as typeof fetch

function summary(path: string, id: string): DocumentSummary {
  return { id, path, kind: 'spatial', updatedAt: '2026-01-01T00:00:00.000Z' }
}

function options(over: Partial<Parameters<typeof useDaemonDocumentBackend>[0]> = {}) {
  return {
    daemonBaseUrl: DAEMON_BASE_URL,
    token: 'tok',
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
    const injected = { name: 'injected' } as unknown as DocumentBackend
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
