/**
 * S-C2 multi-canvas UI (real IndexedDB): draw on canvas A, create+switch to a
 * fresh empty canvas B via the page's New-canvas control, switch back to A via
 * the switcher, and confirm A's element is restored. Proves the switcher/New
 * UI drives the S-C1 store+controller API end to end, including the
 * useCanvasSync reconnect-on-backend-identity-change path.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import '../index.css'

type ExcalidrawOnChange = (elements: unknown[], appState: unknown, files: unknown) => void

let latestOnChange: ExcalidrawOnChange | null = null
let latestUpdateSceneCalls: Array<{ elements: unknown[] }> = []

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: {
    excalidrawAPI?: (api: unknown) => void
    onChange?: ExcalidrawOnChange
  }) => {
    latestOnChange = props.onChange ?? null
    props.excalidrawAPI?.({
      updateScene: (args: { elements: unknown[] }) => {
        latestUpdateSceneCalls.push(args)
      },
      addFiles: () => {},
      getSceneElements: () => [],
      getAppState: () => ({}),
    })
    return null
  },
  restoreElements: (els: unknown[]) => els,
  CaptureUpdateAction: { NEVER: 'never' },
}))

const { BrowserLocalCanvasPage } = await import('./BrowserLocalCanvasPage.js')

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

/** Raw keys of the 'loroCanvases' object store, real IndexedDB. */
async function loroCanvasesKeys(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('loroCanvases', 'readonly')
      const keysReq = tx.objectStore('loroCanvases').getAllKeys()
      keysReq.onsuccess = () => {
        db.close()
        resolve(keysReq.result as string[])
      }
      keysReq.onerror = () => {
        db.close()
        reject(keysReq.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

/** Element ids persisted for a given canvas id, decoded straight from IndexedDB. */
async function persistedElementIds(canvasId: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('whiteboard')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('loroCanvases', 'readonly')
      const getReq = tx.objectStore('loroCanvases').get(canvasId)
      getReq.onsuccess = () => {
        db.close()
        const envelope = getReq.result as { snapshot: Uint8Array } | undefined
        if (!envelope) {
          resolve([])
          return
        }
        const doc = new Loro()
        doc.import(envelope.snapshot)
        // onSceneChange writes into the MovableList container; fall back to the
        // plain List for a doc that has never had a live scene write.
        const movable = doc.getMovableList('elements').toJSON() as Array<{ id: string }>
        const chosen =
          movable.length > 0 ? movable : (doc.getList('elements').toJSON() as Array<{ id: string }>)
        resolve(chosen.map((el) => el.id))
      }
      getReq.onerror = () => {
        db.close()
        reject(getReq.error)
      }
    }
    req.onerror = () => reject(req.error)
  })
}

describe('BrowserLocalCanvasPage multi-canvas UI (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
    latestOnChange = null
    latestUpdateSceneCalls = []
  })

  afterEach(() => {
    cleanup()
  })

  it('draws on A, New switches to empty B, switching back to A restores the drawn element', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })

    const idA = await waitFor(
      () => {
        const heading = screen.getByRole('heading', { level: 1 })
        expect(heading).toBeTruthy()
        const switcher = screen.getByRole('combobox', { name: /canvases/i }) as HTMLSelectElement
        expect(switcher.value).not.toBe('')
        return switcher.value
      },
      { timeout: 5000 },
    )

    const rectangle = {
      id: 'multi-canvas-rect-a',
      type: 'rectangle',
      x: 10,
      y: 10,
      width: 80,
      height: 40,
    }

    // Re-fire until the write lands in loroCanvases (see reload-elements test
    // for why: the backend connects asynchronously with no sync signal).
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!([rectangle], {}, {})
        })
        const keys = await loroCanvasesKeys()
        expect(keys).toContain(idA)
      },
      { timeout: 10000, interval: 600 },
    )

    // Create canvas B and switch to it.
    const newBtn = screen.getByRole('button', { name: /new canvas/i })
    await act(async () => {
      newBtn.click()
    })

    const idB = await waitFor(
      () => {
        const switcher = screen.getByRole('combobox', { name: /canvases/i }) as HTMLSelectElement
        expect(switcher.value).not.toBe(idA)
        return switcher.value
      },
      { timeout: 5000 },
    )

    // B is a fresh canvas: its persisted doc must never contain A's element —
    // asserted straight from IndexedDB so the check is independent of the mock
    // Excalidraw's render timing.
    expect(await persistedElementIds(idB)).not.toContain('multi-canvas-rect-a')

    // No stray placeholder row from the backend re-key.
    expect(await loroCanvasesKeys()).not.toContain('__placeholder__')

    // Switch back to A via the switcher control.
    const switcherBack = screen.getByRole('combobox', { name: /canvases/i }) as HTMLSelectElement
    const { fireEvent } = await import('@testing-library/react')
    await act(async () => {
      fireEvent.change(switcherBack, { target: { value: idA } })
    })

    await waitFor(
      () => {
        const restoredIds = latestUpdateSceneCalls.flatMap((call) =>
          (call.elements as Array<{ id: string }>).map((el) => el.id),
        )
        expect(restoredIds).toContain('multi-canvas-rect-a')
      },
      { timeout: 5000 },
    )

    expect(await loroCanvasesKeys()).not.toContain('__placeholder__')
  })
})
