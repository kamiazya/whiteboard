/**
 * Reload-loses-elements regression (real IndexedDB).
 *
 * Root cause: useCanvasSync connected once to whichever backend it was first
 * given, then never reconnected — so BrowserLocalCanvasPage's placeholder
 * backend (used while the initial snapshot loads) stayed connected forever
 * and the real per-canvas backend's writes never happened. Elements drawn
 * before the initial load settled were silently dropped, and a stray
 * '__placeholder__' row accumulated in IndexedDB.
 *
 * Excalidraw is mocked here (unlike BrowserLocalCanvasPage.browser.test.tsx)
 * so the test can drive a scene change deterministically via onChange
 * instead of simulating pointer drawing; the backend/IndexedDB layer under
 * test remains real.
 */

import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import '../index.css'

// The page reads/writes the canvas id through the router, so it needs a router
// in scope exactly as it has one in main.tsx.
function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

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
  exportToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  exportToSvg: vi.fn(async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
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

describe('BrowserLocalCanvasPage reload persistence (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
    latestOnChange = null
    latestUpdateSceneCalls = []
  })

  afterEach(() => {
    cleanup()
  })

  it('persists a drawn element across remount and never writes a __placeholder__ row', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })

    const rectangle = {
      id: 'reload-regression-rect',
      type: 'rectangle',
      x: 10,
      y: 10,
      width: 80,
      height: 40,
    }

    // The backend connects asynchronously after the editing state mounts, and
    // there is no synchronous "connected" signal to await. Re-fire the same
    // (idempotent) element on each poll so a change dispatched before the
    // connection settles is retried until it lands, then wait for the debounce
    // (300ms) to flush the write into the real canvas row (not '__placeholder__').
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!([rectangle], {}, {})
        })
        const keys = await loroCanvasesKeys()
        expect(keys.length).toBeGreaterThan(0)
      },
      { timeout: 10000, interval: 600 },
    )

    const keysAfterDraw = await loroCanvasesKeys()
    expect(keysAfterDraw).not.toContain('__placeholder__')

    cleanup()
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })

    // The restored scene must include the element drawn before remount.
    await waitFor(
      () => {
        const restoredIds = latestUpdateSceneCalls.flatMap((call) =>
          (call.elements as Array<{ id: string }>).map((el) => el.id),
        )
        expect(restoredIds).toContain('reload-regression-rect')
      },
      { timeout: 5000 },
    )

    const keysAfterRemount = await loroCanvasesKeys()
    expect(keysAfterRemount).not.toContain('__placeholder__')
  })
})
