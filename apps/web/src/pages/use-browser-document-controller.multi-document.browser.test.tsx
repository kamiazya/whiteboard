/**
 * S-C1 multi-canvas foundation (real IndexedDB): listDocuments / createSeededDocument /
 * switchDocument against the production BrowserDocumentIndex, proving id-addressed
 * isolation between documents rather than relying on the fake-indexeddb node tests.
 */

import { readSpatialCanvas, writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserDocumentIndex } from '../lib/browser-document-index.js'
import { IdbDefaultDocumentPointer, idbContentClock } from '../lib/browser-document-summary.js'
import { createSeededDocument } from '../lib/create-seeded-document.js'
import { loadDocumentContent } from '../lib/workspace-content.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedTreeContent } from '../test-utils/seed-workspace-content.js'
import { useBrowserDocumentController } from './use-browser-document-controller.js'

// The claim seeds the db-name seam every opener in this page resolves;
// nothing here needs the name itself now that clearWhiteboardDb reads it.
claimIsolatedWhiteboardDb('use-browser-document-controller-multi-document')

function snapshotWithNode(id: string): Uint8Array {
  const doc = new Loro()
  writeSpatialCanvas(doc, {
    nodes: [textNode({ id, x: 0, y: 0, width: 80, height: 40, text: id })],
    edges: [],
  })
  return doc.export({ mode: 'snapshot' })
}

/** The production create path over the same stores the controller defaults to. */
function createSeeded(index: BrowserDocumentIndex, name: string) {
  return createSeededDocument(index, idbContentClock(), name)
}

describe('multi-canvas foundation (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(async () => {
    cleanup()
    await clearWhiteboardDb()
  })

  it('createSeededDocument twice persists both, and listDocuments returns both by their real id', async () => {
    const store = new BrowserDocumentIndex()
    const { result } = renderHook(() => useBrowserDocumentController(store))
    await act(async () => {})

    let idA = ''
    let idB = ''
    await act(async () => {
      idA = (await createSeeded(store, 'Canvas A')).documentId
    })
    await act(async () => {
      idB = (await createSeeded(store, 'Canvas B')).documentId
    })

    const list = await result.current.listDocuments()
    const ids = list.map((c) => c.documentId)
    expect(ids).toContain(idA)
    expect(ids).toContain(idB)
    expect(list.find((c) => c.documentId === idA)?.name).toBe('Canvas A')
    expect(list.find((c) => c.documentId === idB)?.name).toBe('Canvas B')

    // createSeededDocument seeds an empty document so a switch onto a never-edited
    // canvas delivers a valid empty doc rather than not-found.
    await expect(loadDocumentContent(idA)).resolves.not.toBeNull()
    await expect(loadDocumentContent(idB)).resolves.not.toBeNull()
  })

  it('two documents hold independent content — writing to one never leaks into the other', async () => {
    const store = new BrowserDocumentIndex()
    renderHook(() => useBrowserDocumentController(store))
    await act(async () => {})

    let idA = ''
    let idB = ''
    await act(async () => {
      idA = (await createSeeded(store, 'Canvas A')).documentId
    })
    await act(async () => {
      idB = (await createSeeded(store, 'Canvas B')).documentId
    })

    await seedTreeContent(idA, snapshotWithNode('node-a'))
    await seedTreeContent(idB, snapshotWithNode('node-b'))

    const docA = await loadDocumentContent(idA)
    const docB = await loadDocumentContent(idB)
    if (docA === null || docB === null) throw new Error('content did not load')
    expect(readSpatialCanvas(docA).nodes.map((n) => n.id)).toEqual(['node-a'])
    expect(readSpatialCanvas(docB).nodes.map((n) => n.id)).toEqual(['node-b'])
  })

  it('switchDocument swaps the current snapshot and the persisted default pointer, A -> B -> A', async () => {
    const store = new BrowserDocumentIndex()
    const { result } = renderHook(() => useBrowserDocumentController(store))
    await waitFor(() => expect(result.current.snapshot).not.toBeNull())
    const idA = result.current.snapshot!.documentId

    let idB = ''
    await act(async () => {
      idB = (await createSeeded(store, 'Canvas B')).documentId
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
    const index = new BrowserDocumentIndex()
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
