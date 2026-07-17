/**
 * Image-persists-across-reload regression (real IndexedDB, real
 * BrowserLocalBackend/CanvasFileStore — only Excalidraw itself is mocked,
 * since it requires native roughjs bindings jsdom/CI cannot provide).
 *
 * This exercises the actual wiring an image paste goes through in
 * production: onChange with a new image element + its file data URL ->
 * BrowserLocalBackend.putFile -> CanvasFileStore (IndexedDB) -> remount ->
 * BrowserLocalBackend.getFile -> useCanvasSync's applyLoroToExcalidraw ->
 * ExcalidrawImperativeAPI.addFiles. A wiring or lifecycle regression that
 * silently drops the getFile round trip (the bug this file's sibling unit
 * tests target individually) would still show up here because nothing
 * between the page and IndexedDB is mocked.
 */

import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import '../index.css'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

type ExcalidrawOnChange = (
  elements: unknown[],
  appState: unknown,
  files: Record<string, unknown>,
) => void

interface CapturedFile {
  id: string
  mimeType: string
  dataURL: string
}

let latestOnChange: ExcalidrawOnChange | null = null
let addFilesCalls: CapturedFile[][] = []

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: {
    excalidrawAPI?: (api: unknown) => void
    onChange?: ExcalidrawOnChange
  }) => {
    latestOnChange = props.onChange ?? null
    props.excalidrawAPI?.({
      updateScene: () => {},
      addFiles: (files: CapturedFile[]) => {
        addFilesCalls.push(files)
      },
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

// Rejects on failure: silently keeping stale image-persistence records
// would let both halves of this regression test pass on stale data.
async function clearDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('whiteboard database deletion was blocked'))
  })
}

// 1x1 transparent PNG, matching canvas-file-store.test.ts's fixture.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

describe('BrowserLocalCanvasPage image persistence (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
    latestOnChange = null
    addFilesCalls = []
  })

  afterEach(() => {
    cleanup()
  })

  it('restores a pasted image after remount via the real backend/IndexedDB round trip', async () => {
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })

    const imageElement = {
      id: 'image-persistence-el',
      type: 'image',
      fileId: 'image-persistence-file',
      x: 10,
      y: 10,
      width: 40,
      height: 40,
    }
    const files = {
      'image-persistence-file': {
        id: 'image-persistence-file',
        mimeType: 'image/png',
        dataURL: PNG_DATA_URL,
        created: Date.now(),
      },
    }

    // The backend connects asynchronously; re-fire (idempotent) until the
    // putFile write actually lands, then wait for the debounce to flush —
    // matching BrowserLocalCanvasPage.reload-elements.browser.test.tsx's
    // pattern for the same async-connect race.
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!([imageElement], {}, files)
        })
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('whiteboard')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const stored = await new Promise<unknown>((resolve, reject) => {
          const tx = db.transaction('canvasFiles', 'readonly')
          const getReq = tx.objectStore('canvasFiles').get('image-persistence-file')
          getReq.onsuccess = () => resolve(getReq.result)
          getReq.onerror = () => reject(getReq.error)
          tx.oncomplete = () => db.close()
        })
        expect(stored).not.toBeUndefined()
      },
      { timeout: 10000, interval: 600 },
    )

    cleanup()
    addFilesCalls = []
    render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
    await waitFor(() => expect(screen.getByTestId('excalidraw-container')).toBeInTheDocument(), {
      timeout: 5000,
    })

    // The restored file must reach Excalidraw's addFiles with matching bytes
    // — proving the whole getFile -> blobToBase64 -> addFiles chain survived
    // a real remount, not just that IndexedDB holds a row.
    await waitFor(
      () => {
        const restored = addFilesCalls.flat().find((f) => f.id === 'image-persistence-file')
        expect(restored).toBeDefined()
        expect(restored?.mimeType).toBe('image/png')
        expect(restored?.dataURL).toBe(PNG_DATA_URL)
      },
      { timeout: 5000 },
    )
  })
})
