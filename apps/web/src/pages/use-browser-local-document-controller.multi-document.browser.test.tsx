/**
 * S-C1 multi-canvas foundation (real IndexedDB): listDocuments / createDocument /
 * switchDocument against the real IndexedDBStore + LoroStore, proving id-addressed
 * isolation between documents rather than relying on the fake-indexeddb node tests.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import { LoroStore } from '../lib/loro-store.js'
import { useBrowserLocalDocumentController } from './use-browser-local-document-controller.js'

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

function snapshotWithElements(elements: unknown[]): Uint8Array {
  const doc = new Loro()
  const list = doc.getList('elements')
  for (const el of elements) list.push(el)
  return doc.export({ mode: 'snapshot' })
}

describe('multi-canvas foundation (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  afterEach(async () => {
    cleanup()
    await clearDb()
  })

  it('createDocument twice persists both, and listDocuments returns both by their real id', async () => {
    const store = new IndexedDBStore()
    const loro = new LoroStore()
    const { result } = renderHook(() => useBrowserLocalDocumentController(store, loro))
    await act(async () => {})

    let idA = ''
    let idB = ''
    await act(async () => {
      idA = (await result.current.createDocument('Canvas A')).documentId
    })
    await act(async () => {
      idB = (await result.current.createDocument('Canvas B')).documentId
    })

    const list = await result.current.listDocuments()
    const ids = list.map((c) => c.documentId)
    expect(ids).toContain(idA)
    expect(ids).toContain(idB)
    expect(list.find((c) => c.documentId === idA)?.name).toBe('Canvas A')
    expect(list.find((c) => c.documentId === idB)?.name).toBe('Canvas B')

    // createDocument seeds an empty Loro doc so a switch onto a never-edited
    // canvas delivers a valid empty doc rather than not-found.
    expect((await loro.load(idA)).kind).toBe('ok')
    expect((await loro.load(idB)).kind).toBe('ok')
  })

  it('two documents hold independent elements in loroCanvases — writing to one never leaks into the other', async () => {
    const store = new IndexedDBStore()
    const loro = new LoroStore()
    const { result } = renderHook(() => useBrowserLocalDocumentController(store, loro))
    await act(async () => {})

    let idA = ''
    let idB = ''
    await act(async () => {
      idA = (await result.current.createDocument('Canvas A')).documentId
    })
    await act(async () => {
      idB = (await result.current.createDocument('Canvas B')).documentId
    })

    await loro.save(idA, snapshotWithElements([{ id: 'rect-a', type: 'rectangle' }]))
    await loro.save(idB, snapshotWithElements([{ id: 'rect-b', type: 'rectangle' }]))

    const loadedA = await loro.load(idA)
    const loadedB = await loro.load(idB)
    expect(loadedA.kind).toBe('ok')
    expect(loadedB.kind).toBe('ok')
    if (loadedA.kind === 'ok' && loadedB.kind === 'ok') {
      const docA = new Loro()
      docA.import(loadedA.snapshot)
      const docB = new Loro()
      docB.import(loadedB.snapshot)
      expect(docA.getList('elements').toJSON()).toEqual([{ id: 'rect-a', type: 'rectangle' }])
      expect(docB.getList('elements').toJSON()).toEqual([{ id: 'rect-b', type: 'rectangle' }])
    }
  })

  it('switchDocument swaps the current snapshot and the persisted default pointer, A -> B -> A', async () => {
    const store = new IndexedDBStore()
    const loro = new LoroStore()
    const { result } = renderHook(() => useBrowserLocalDocumentController(store, loro))
    await waitFor(() => expect(result.current.snapshot).not.toBeNull())
    const idA = result.current.snapshot!.documentId

    let idB = ''
    await act(async () => {
      idB = (await result.current.createDocument('Canvas B')).documentId
    })

    await act(async () => {
      await result.current.switchDocument(idB)
    })
    expect(result.current.snapshot?.documentId).toBe(idB)
    expect(await store.getDefaultDocumentId()).toBe(idB)

    await act(async () => {
      await result.current.switchDocument(idA)
    })
    expect(result.current.snapshot?.documentId).toBe(idA)
    expect(await store.getDefaultDocumentId()).toBe(idA)
  })

  it('duplicateDocument deep-copies the Loro doc: later source edits never leak', async () => {
    const store = new IndexedDBStore()
    const loro = new LoroStore()
    const { result } = renderHook(() => useBrowserLocalDocumentController(store, loro))
    await waitFor(() => expect(result.current.snapshot).not.toBeNull())
    const sourceId = result.current.snapshot!.documentId
    await loro.save(sourceId, snapshotWithElements([{ id: 'original-element' }]))

    let duplicated: Awaited<ReturnType<typeof result.current.duplicateDocument>> | undefined
    await act(async () => {
      duplicated = await result.current.duplicateDocument()
    })
    expect(duplicated?.documentId).not.toBe(sourceId)
    expect(result.current.snapshot?.documentId).toBe(duplicated?.documentId)

    // Edit the SOURCE canvas's real IndexedDB record after duplicating.
    const loadedSource = await loro.load(sourceId)
    expect(loadedSource.kind).toBe('ok')
    if (loadedSource.kind !== 'ok') return
    const sourceDoc = new Loro()
    sourceDoc.import(loadedSource.snapshot)
    sourceDoc.getList('elements').push({ id: 'added-after-duplicate' })
    await loro.save(sourceId, sourceDoc.export({ mode: 'snapshot' }))

    const loadedCopy = await loro.load(duplicated!.documentId)
    expect(loadedCopy.kind).toBe('ok')
    if (loadedCopy.kind !== 'ok') return
    const copyDoc = new Loro()
    copyDoc.import(loadedCopy.snapshot)
    expect(copyDoc.getList('elements').toJSON()).toEqual([{ id: 'original-element' }])
  })
})
