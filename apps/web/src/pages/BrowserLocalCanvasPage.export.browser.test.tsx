import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'
import '../index.css'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('whiteboard')
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

// Captures every Blob handed to URL.createObjectURL so assertions can inspect
// the real payload instead of only the downloaded filename — a regression
// that bypasses commands.exportJson (e.g. falling through to exportScene for
// the 'json' format) would still produce *a* download, but not this content.
function captureExportedBlobs(): { blobs: Blob[] } {
  const captured: Blob[] = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
    captured.push(obj as Blob)
    return 'blob:mock-url'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { blobs: captured }
}

async function renderLoaded(): Promise<void> {
  render(<BrowserLocalCanvasPage store={new IndexedDBStore()} />)
  await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(), {
    timeout: 5000,
  })
}

// Opening WorkspaceTopBar's "Canvas actions" dropdown occasionally does not
// register on the first pointerdown the first time it's opened in a given
// test file in real-browser mode (never reproduces in jsdom) — retry with a
// full remount rather than let that tooling artifact fail a real behavioral
// assertion. Mirrors the same pattern in BrowserLocalCanvasPage.rename.browser.test.tsx.
async function openExportMenuItem(label: string): Promise<HTMLElement> {
  let item: HTMLElement | undefined
  for (let attempt = 0; attempt < 8 && !item; attempt++) {
    if (attempt > 0) {
      cleanup()
      await renderLoaded()
    }
    const allCanvasActions = await waitFor(() => screen.getAllByLabelText('Canvas actions'), {
      timeout: 5000,
    })
    const canvasActions = allCanvasActions[allCanvasActions.length - 1]!
    fireEvent.pointerDown(canvasActions, { button: 0, ctrlKey: false })
    try {
      const allItems = await waitFor(() => screen.getAllByText(label), { timeout: 1500 })
      item = allItems[allItems.length - 1]!
    } catch {
      // retry with a fresh remount
    }
  }
  if (!item) throw new Error(`Canvas actions dropdown never opened after retries (${label})`)
  return item
}

describe('BrowserLocalCanvasPage export (browser — real SpatialEditor, no Excalidraw)', () => {
  beforeEach(async () => {
    await clearDb()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('exports SVG through the imperative-API-free exportScene path', async () => {
    await renderLoaded()
    const { blobs } = captureExportedBlobs()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const svgItem = await openExportMenuItem('Export as SVG')
    fireEvent.pointerUp(svgItem)

    await waitFor(() => expect(clickSpy).toHaveBeenCalled())
    expect(blobs).toHaveLength(1)
    const blob = blobs[0]
    expect(blob.type).toBe('image/svg+xml')
    const text = await blob.text()
    expect(text).toContain('<svg')
  })

  // SpatialEditor exposes no Excalidraw-shaped imperative API, so
  // commands.exportJson's `getExcalidrawApi() === null` branch always
  // throws CommandError('no-api', ...); createSceneExportHandler degrades
  // that to a null blob, which useSceneExport surfaces as a visible error
  // instead of downloading anything. Pinned here (a real-browser mount, not
  // a mocked one) so this degraded state is a known one, not silently
  // broken.
  it('surfaces a visible error for JSON export instead of downloading a .excalidraw envelope', async () => {
    await renderLoaded()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const jsonItem = await openExportMenuItem('Export as JSON')
    fireEvent.pointerUp(jsonItem)

    await waitFor(() => {
      expect(screen.getByText(/export as excalidraw json failed/i)).toBeInTheDocument()
    })
    expect(clickSpy).not.toHaveBeenCalled()
  })
})
