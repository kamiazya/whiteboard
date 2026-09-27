/**
 * What a confirmed delete leaves open, and the order it writes in. Split from
 * the controller's main file, which is at its size budget.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { LocalStoreDouble } from '../test-utils/local-index.js'
import { useBrowserDocumentController } from './use-browser-document-controller.js'

const C1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const C2 = '01ARZ3NDEKTSV4RRFFQ69G5FB0'

const snap: DocumentSnapshot = {
  documentId: C1,
  workspaceId: getBrowserWorkspaceId(),
  path: 'untitled',
  name: 'untitled',
  updatedAt: '2026-05-24T00:00:00.000Z',
  kind: 'spatial' as const,
}

describe('useBrowserDocumentController delete', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('deleteDocument flushes pending save, deletes, and opens a fresh document when none is left', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    act(() => {
      result.current.renameDocument('Renamed before cleanup')
    })
    await act(async () => {
      await result.current.deleteDocument()
    })
    // Nothing was left, so the page is on a fresh document — this keeper's
    // first-visit answer — and the pointer names it rather than the deleted one.
    const opened = result.current.snapshot
    expect(opened).not.toBeNull()
    expect(opened?.documentId).not.toBe(C1)
    expect(await store.getDefaultDocumentId()).toBe(opened?.documentId)
    expect(
      await store.index.resolveDocumentById({
        workspaceId: getBrowserWorkspaceId(),
        documentId: C1,
      }),
    ).toBeNull()
  })

  it('deleteDocument never leaves the pointer naming a row that is gone', async () => {
    // A load between the two writes read the pointer, found no row behind it
    // and reported "could not be read". Cleared first, a load in that window
    // finds no pointer and opens as a first visit would.
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const pointerWhenRowGoes: (string | null)[] = []
    const remove = store.index.deleteDocument.bind(store.index)
    store.index.deleteDocument = async (input) => {
      await remove(input)
      pointerWhenRowGoes.push(await store.getDefaultDocumentId())
    }
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      await result.current.deleteDocument()
    })
    expect(pointerWhenRowGoes).toEqual([null])
  })

  it('deleteDocument opens the document that is left', async () => {
    const store = new LocalStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    await store.save({ ...snap, documentId: C2, path: 'other', name: 'Other' })
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: store.clock,
      }),
    )
    await act(async () => {})
    await act(async () => {
      await result.current.deleteDocument()
    })
    expect(result.current.snapshot?.documentId).toBe(C2)
    expect(await store.getDefaultDocumentId()).toBe(C2)
  })
})
