import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { useDocumentListRefresh } from './use-document-list-refresh.js'

const snapshot = (documentId: string): DocumentSnapshot =>
  ({
    documentId,
    path: documentId,
    name: documentId,
    updatedAt: '2026-01-01',
    kind: 'spatial',
  }) as DocumentSnapshot

describe('useDocumentListRefresh', () => {
  it('drops a stale resolution rather than letting it clobber a newer refresh', async () => {
    // The race the generation guard exists for: a fast switch starts a second
    // enumeration while the first is still in flight, and the FIRST resolves
    // last. Without the guard the switcher ends up showing the departed
    // document's list under the arrived document.
    //
    // Measured before this test existed: deleting the guard left all 418
    // files and 4391 tests of `web-jsdom` green. It was described by a
    // comment and held by nothing.
    const resolvers: ((list: DocumentSnapshot[]) => void)[] = []
    const listDocuments = vi.fn(
      () => new Promise<DocumentSnapshot[]>((resolve) => resolvers.push(resolve)),
    )

    const { result, rerender } = renderHook(
      ({ documentId }: { documentId: string }) =>
        useDocumentListRefresh({ documentId, currentUpdatedAt: null, listDocuments }),
      { initialProps: { documentId: 'first' } },
    )
    await waitFor(() => expect(resolvers.length).toBe(1))

    rerender({ documentId: 'second' })
    await waitFor(() => expect(resolvers.length).toBe(2))

    // The newer enumeration lands first, then the older one arrives late.
    await act(async () => {
      resolvers[1]?.([snapshot('from-second')])
      resolvers[0]?.([snapshot('from-first')])
    })

    expect(result.current.documents.map((entry) => entry.documentId)).toEqual(['from-second'])
  })

  it('reports that the list has answered, which "no such path" is told apart by', async () => {
    const listDocuments = vi.fn(async () => [snapshot('only')])
    const { result } = renderHook(() =>
      useDocumentListRefresh({ documentId: 'doc', currentUpdatedAt: null, listDocuments }),
    )
    expect(result.current.enumeratedRef.current).toBe(false)
    await waitFor(() => expect(result.current.enumeratedRef.current).toBe(true))
  })

  // A refusal is reported only for the refresh somebody is waiting on. The
  // other two land AFTER the page moved on, and the setup's logged-failure
  // guard would file them against whatever test is running by then — which is
  // how this file's neighbour failed under `--repeats`: its last page's refresh
  // rejected into the next repeat, whose database had just been cleared.
  it('reports a refusal of the current refresh', async () => {
    const listDocuments = vi.fn(async () => {
      throw new Error('store unreachable')
    })
    renderHook(() =>
      useDocumentListRefresh({ documentId: 'doc', currentUpdatedAt: null, listDocuments }),
    )
    await expectLoggedFailure('listDocuments failed')
  })

  it('stays silent on a refusal that arrives after the page is gone', async () => {
    const rejecters: ((err: Error) => void)[] = []
    const listDocuments = vi.fn(
      () => new Promise<DocumentSnapshot[]>((_resolve, reject) => rejecters.push(reject)),
    )
    const { unmount } = renderHook(() =>
      useDocumentListRefresh({ documentId: 'doc', currentUpdatedAt: null, listDocuments }),
    )
    await waitFor(() => expect(rejecters.length).toBe(1))
    unmount()
    await act(async () => {
      rejecters[0]?.(new Error('cleared under it'))
    })
    // Nothing to assert here: the setup's afterEach fails this test on any
    // logged failure it did not claim, and this test claims none.
  })

  it('stays silent on a refusal of a refresh a newer one superseded', async () => {
    const rejecters: ((err: Error) => void)[] = []
    const listDocuments = vi.fn(
      () => new Promise<DocumentSnapshot[]>((_resolve, reject) => rejecters.push(reject)),
    )
    const { rerender } = renderHook(
      ({ documentId }: { documentId: string }) =>
        useDocumentListRefresh({ documentId, currentUpdatedAt: null, listDocuments }),
      { initialProps: { documentId: 'first' } },
    )
    await waitFor(() => expect(rejecters.length).toBe(1))
    rerender({ documentId: 'second' })
    await waitFor(() => expect(rejecters.length).toBe(2))
    await act(async () => {
      rejecters[0]?.(new Error('late refusal'))
    })
  })

  it('asks for nothing while no document is loaded', () => {
    const listDocuments = vi.fn(async () => [])
    renderHook(() =>
      useDocumentListRefresh({ documentId: null, currentUpdatedAt: null, listDocuments }),
    )
    expect(listDocuments).not.toHaveBeenCalled()
  })
})
