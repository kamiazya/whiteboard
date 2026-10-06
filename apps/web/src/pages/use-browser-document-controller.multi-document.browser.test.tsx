/**
 * S-C1 multi-canvas foundation (real IndexedDB): listDocuments / createDocument /
 * switchDocument against the production FoldingBrowserIndex, proving id-addressed
 * isolation between documents rather than relying on the fake-indexeddb node tests.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdbDefaultDocumentPointer } from '../lib/browser-document-summary.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { LoroStore } from '../lib/loro-store.js'
import { loadDocumentContent } from '../lib/workspace-content.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { useBrowserDocumentController } from './use-browser-document-controller.js'

// The claim seeds the db-name seam every opener in this page resolves;
// nothing here needs the name itself now that clearWhiteboardDb reads it.
claimIsolatedWhiteboardDb('use-browser-document-controller-multi-document')

function snapshotWithElements(elements: unknown[]): Uint8Array {
  const doc = new Loro()
  const list = doc.getList('elements')
  for (const el of elements) list.push(el)
  return doc.export({ mode: 'snapshot' })
}

describe('multi-canvas foundation (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(async () => {
    cleanup()
    await clearWhiteboardDb()
  })

  it('createDocument twice persists both, and listDocuments returns both by their real id', async () => {
    const store = new FoldingBrowserIndex()
    const { result } = renderHook(() => useBrowserDocumentController(store))
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

    // createDocument seeds an empty document so a switch onto a never-edited
    // canvas delivers a valid empty doc rather than not-found.
    await expect(loadDocumentContent(idA)).resolves.not.toBeNull()
    await expect(loadDocumentContent(idB)).resolves.not.toBeNull()
  })

  it('two documents hold independent elements in loroCanvases — writing to one never leaks into the other', async () => {
    const store = new FoldingBrowserIndex()
    const loro = new LoroStore()
    const { result } = renderHook(() => useBrowserDocumentController(store))
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
    const store = new FoldingBrowserIndex()
    const { result } = renderHook(() => useBrowserDocumentController(store))
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
    expect(await new IdbDefaultDocumentPointer().get()).toBe(idB)

    await act(async () => {
      await result.current.switchDocument(idA)
    })
    expect(result.current.snapshot?.documentId).toBe(idA)
    expect(await new IdbDefaultDocumentPointer().get()).toBe(idA)
  })

  // That the copy is a deep one — a later edit to the source leaves it as it
  // was — is the DocumentDuplicates conformance suite's, which this index
  // answers to.
  it('duplicate switches onto the copy the production index made', async () => {
    const index = new FoldingBrowserIndex()
    const { result } = renderHook(() => useBrowserDocumentController(index))
    await waitFor(() => expect(result.current.snapshot).not.toBeNull())
    const source = result.current.snapshot!

    let duplicated: Awaited<ReturnType<typeof result.current.duplicateDocument>> | undefined
    await act(async () => {
      duplicated = await result.current.duplicateDocument()
    })

    expect(duplicated?.documentId).not.toBe(source.documentId)
    expect(duplicated?.path).toBe(`${source.path}-copy`)
    expect(result.current.snapshot?.documentId).toBe(duplicated?.documentId)
    await expect(loadDocumentContent(duplicated!.documentId)).resolves.not.toBeNull()
  })
})
