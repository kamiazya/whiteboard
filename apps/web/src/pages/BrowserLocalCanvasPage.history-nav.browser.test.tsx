/**
 * Browser Back/Forward must round-trip through the loaded canvas, not just
 * the address bar: create+switch to a second canvas, go Back to the first
 * (proving the URL->switchCanvas direction fires), then Forward to the
 * second again.
 */

import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import '../index.css'

type ExcalidrawOnChange = (elements: unknown[], appState: unknown, files: unknown) => void

let latestOnChange: ExcalidrawOnChange | null = null

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: {
    excalidrawAPI?: (api: unknown) => void
    onChange?: ExcalidrawOnChange
  }) => {
    latestOnChange = props.onChange ?? null
    props.excalidrawAPI?.({
      updateScene: () => {},
      addFiles: () => {},
      getSceneElements: () => [],
      getAppState: () => ({}),
    })
    return null
  },
  restoreElements: (els: unknown[]) => els,
  CaptureUpdateAction: { NEVER: 'never' },
  exportToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  exportToSvg: vi.fn(async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
}))

const { BrowserLocalCanvasPage } = await import('./BrowserLocalCanvasPage.js')

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
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
        const envelope = getReq.result as
          | { snapshot: Uint8Array; deltas?: Uint8Array[] }
          | undefined
        if (!envelope) {
          resolve([])
          return
        }
        const doc = new Loro()
        doc.import(envelope.snapshot)
        for (const delta of envelope.deltas ?? []) {
          doc.import(delta)
        }
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

describe('BrowserLocalCanvasPage browser Back/Forward (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
    latestOnChange = null
  })

  afterEach(() => {
    cleanup()
  })

  it('Back returns to the first canvas and Forward returns to the second', async () => {
    const store = new IndexedDBStore()
    const router = createMemoryRouter(
      [{ path: '*', element: <BrowserLocalCanvasPage store={store} /> }],
      { initialEntries: ['/'] },
    )
    rtlRender(<RouterProvider router={router} />)

    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })

    const idA = await waitFor(
      async () => {
        const id = await store.getDefaultCanvasId()
        expect(id).not.toBeNull()
        return id as string
      },
      { timeout: 5000 },
    )

    const rectA = { id: 'history-nav-rect-a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!([rectA], {}, {})
        })
        expect(await persistedElementIds(idA)).toContain('history-nav-rect-a')
      },
      { timeout: 10000, interval: 600 },
    )

    // Create canvas B via the switcher's New-canvas control.
    const switcherA = await screen.findByRole('button', { name: 'untitled' })
    fireEvent.pointerDown(switcherA, { button: 0, ctrlKey: false })
    const newItem = await screen.findByTestId('new-canvas-menu-item')
    await act(async () => {
      fireEvent.pointerUp(newItem)
    })

    const idB = await waitFor(
      async () => {
        const id = await store.getDefaultCanvasId()
        expect(id).not.toBe(idA)
        return id as string
      },
      { timeout: 5000 },
    )

    await waitFor(() => expect(router.state.location.pathname).toBe(`/local/${idB}`), {
      timeout: 5000,
    })

    const rectB = {
      id: 'history-nav-rect-b',
      type: 'rectangle',
      x: 20,
      y: 20,
      width: 10,
      height: 10,
    }
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!([rectB], {}, {})
        })
        expect(await persistedElementIds(idB)).toContain('history-nav-rect-b')
      },
      { timeout: 10000, interval: 600 },
    )

    // Back: real browser Back/Forward drives router history the same way
    // router.navigate(-1) does — a POP navigation the component never
    // triggers itself.
    await act(async () => {
      await router.navigate(-1)
    })

    await waitFor(() => expect(router.state.location.pathname).toBe(`/local/${idA}`), {
      timeout: 5000,
    })
    await waitFor(
      async () => {
        expect(await store.getDefaultCanvasId()).toBe(idA)
      },
      { timeout: 5000 },
    )
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument())

    // Forward: back to B.
    await act(async () => {
      await router.navigate(1)
    })

    await waitFor(() => expect(router.state.location.pathname).toBe(`/local/${idB}`), {
      timeout: 5000,
    })
    await waitFor(
      async () => {
        expect(await store.getDefaultCanvasId()).toBe(idB)
      },
      { timeout: 5000 },
    )
  })
})
