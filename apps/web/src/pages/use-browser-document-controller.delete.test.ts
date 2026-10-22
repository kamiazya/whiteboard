/**
 * What a confirmed delete writes, and the order it writes in. It opens nothing:
 * the page leaves for the workspace list. Split from the controller's main
 * file, which is at its size budget.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { BrowserStoreDouble } from '../test-utils/browser-store-fixture.js'
import { useBrowserDocumentController } from './use-browser-document-controller.js'

const C1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const C2 = '01ARZ3NDEKTSV4RRFFQ69G5FB0'

const snap: DocumentSnapshot = {
  documentId: C1,
  workspaceId: getBrowserWorkspaceId(),
  path: 'untitled',
  name: null,
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

  it('deleteDocument flushes the pending save, deletes, and opens nothing in its place', async () => {
    const store = new BrowserStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    const renames: string[] = []
    const setName = store.index.setDocumentName.bind(store.index)
    store.index.setDocumentName = async (input) => {
      renames.push(`${input.documentId}:${input.name ?? ''}`)
      await setName(input)
    }
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
    // The rename reached the index before the row went, and no fresh document
    // was seeded: the pointer names nothing and the workspace holds nothing.
    expect(renames).toEqual([`${C1}:Renamed before cleanup`])
    expect(await store.getDefaultDocumentId()).toBeNull()
    expect(await store.index.listDocuments({ workspaceId: getBrowserWorkspaceId() })).toEqual([])
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
    const store = new BrowserStoreDouble()
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

  it('deleteDocument leaves the sibling alone and does not repoint at it', async () => {
    const store = new BrowserStoreDouble()
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
    expect(await store.getDefaultDocumentId()).toBeNull()
    const left = await store.index.listDocuments({ workspaceId: getBrowserWorkspaceId() })
    expect(left.map((d) => d.documentId)).toEqual([C2])
  })

  it('a delete does not depend on listing the index, so a failing listing cannot fail it', async () => {
    // Nothing opens after a delete, so an index that cannot be listed must not
    // turn a stood delete into an error the person sees.
    const store = new BrowserStoreDouble()
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
    expect(result.current.snapshot?.documentId).toBe(C1)
    store.index.listDocuments = async () => {
      throw new Error('the index could not be listed')
    }
    await act(async () => {
      await result.current.deleteDocument()
    })
    expect(result.current.persistence.kind).not.toBe('degraded')
    expect(
      await store.index.resolveDocumentById({
        workspaceId: getBrowserWorkspaceId(),
        documentId: C1,
      }),
    ).toBeNull()
  })

  it('a switch to the document being deleted, landing after the delete, does not bring it back', async () => {
    // The switch read the row before the delete removed it, so nothing it
    // does afterwards can see the row is gone; only the generation the
    // delete stamps stops it from committing.
    const store = new BrowserStoreDouble()
    await store.setDefaultDocumentId(C1)
    await store.save(snap)
    await store.save({ ...snap, documentId: C2, path: 'other', name: 'Other' })
    let parkC1 = false
    let arrived = () => {}
    let release = () => {}
    const switchParked = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const parked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { result } = renderHook(() =>
      useBrowserDocumentController(store.index, {
        loro: store.loro,
        pointer: store.pointer,
        clock: async (ids) => {
          if (parkC1 && ids.includes(C1)) {
            arrived()
            await parked
          }
          return store.clock(ids)
        },
      }),
    )
    await act(async () => {})
    expect(result.current.snapshot?.documentId).toBe(C1)
    parkC1 = true
    let switched: boolean | undefined
    await act(async () => {
      const pending = result.current.switchDocument(C1)
      await switchParked
      await result.current.deleteDocument()
      release()
      switched = await pending
    })
    expect(switched).toBe(false)
    expect(await store.getDefaultDocumentId()).toBeNull()
    expect(
      await store.index.resolveDocumentById({
        workspaceId: getBrowserWorkspaceId(),
        documentId: C1,
      }),
    ).toBeNull()
  })
})
