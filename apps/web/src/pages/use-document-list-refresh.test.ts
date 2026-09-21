import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
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

  it('asks for nothing while no document is loaded', () => {
    const listDocuments = vi.fn(async () => [])
    renderHook(() =>
      useDocumentListRefresh({ documentId: null, currentUpdatedAt: null, listDocuments }),
    )
    expect(listDocuments).not.toHaveBeenCalled()
  })
})
