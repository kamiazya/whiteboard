/**
 * S-C1 multi-canvas foundation (real IndexedDB): listCanvases / createCanvas /
 * switchCanvas against the real IndexedDBStore + LoroStore, proving id-addressed
 * isolation between canvases rather than relying on the fake-indexeddb node tests.
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import { LoroStore } from '../lib/loro-store.js'
import { useBrowserLocalCanvasController } from './use-browser-local-canvas-controller.js'

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

describe('multi-canvas foundation (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  afterEach(async () => {
    cleanup()
    await clearDb()
  })

  it('createCanvas twice persists both, and listCanvases returns both by their real id', async () => {
    const store = new IndexedDBStore()
    const loro = new LoroStore()
    const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
    await act(async () => {})

    let idA = ''
    let idB = ''
    await act(async () => {
      idA = (await result.current.createCanvas('Canvas A')).id
    })
    await act(async () => {
      idB = (await result.current.createCanvas('Canvas B')).id
    })

    const list = await result.current.listCanvases()
    const ids = list.map((c) => c.id)
    expect(ids).toContain(idA)
    expect(ids).toContain(idB)
    expect(list.find((c) => c.id === idA)?.name).toBe('Canvas A')
    expect(list.find((c) => c.id === idB)?.name).toBe('Canvas B')

    // createCanvas seeds an empty Loro doc so a switch onto a never-edited
    // canvas delivers a valid empty doc rather than not-found.
    expect((await loro.load(idA)).kind).toBe('ok')
    expect((await loro.load(idB)).kind).toBe('ok')
  })

  it('two canvases hold independent elements in loroCanvases — writing to one never leaks into the other', async () => {
    const store = new IndexedDBStore()
    const loro = new LoroStore()
    const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
    await act(async () => {})

    let idA = ''
    let idB = ''
    await act(async () => {
      idA = (await result.current.createCanvas('Canvas A')).id
    })
    await act(async () => {
      idB = (await result.current.createCanvas('Canvas B')).id
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

  it('switchCanvas swaps the current snapshot and the persisted default pointer, A -> B -> A', async () => {
    const store = new IndexedDBStore()
    const loro = new LoroStore()
    const { result } = renderHook(() => useBrowserLocalCanvasController(store, loro))
    await waitFor(() => expect(result.current.snapshot).not.toBeNull())
    const idA = result.current.snapshot!.id

    let idB = ''
    await act(async () => {
      idB = (await result.current.createCanvas('Canvas B')).id
    })

    await act(async () => {
      await result.current.switchCanvas(idB)
    })
    expect(result.current.snapshot?.id).toBe(idB)
    expect(await store.getDefaultCanvasId()).toBe(idB)

    await act(async () => {
      await result.current.switchCanvas(idA)
    })
    expect(result.current.snapshot?.id).toBe(idA)
    expect(await store.getDefaultCanvasId()).toBe(idA)
  })
})
