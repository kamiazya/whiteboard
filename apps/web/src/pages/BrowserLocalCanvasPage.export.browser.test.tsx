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
// the real payload instead of only the downloaded filename.
//
// Delegates to the real createObjectURL/revokeObjectURL rather than faking
// the returned URL: the PNG export path (rasterizeSvgToPng) creates its own
// internal object URL to bridge the rendered SVG into a real <img>, and a
// fake URL there breaks that Image load with no relation to the download
// blob under test. So a PNG export produces two captured blobs (the
// intermediate SVG, then the final PNG) — assert on the last one.
function captureExportedBlobs(): { blobs: Blob[] } {
  const captured: Blob[] = []
  const realCreateObjectURL = URL.createObjectURL.bind(URL)
  const realRevokeObjectURL = URL.revokeObjectURL.bind(URL)
  vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
    captured.push(obj as Blob)
    return realCreateObjectURL(obj)
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    realRevokeObjectURL(url)
  })
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

  it('rasterizes PNG through a real Canvas 2D context and <img> load', async () => {
    await renderLoaded()
    const { blobs } = captureExportedBlobs()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const pngItem = await openExportMenuItem('Export as PNG')
    fireEvent.pointerUp(pngItem)

    await waitFor(() => expect(clickSpy).toHaveBeenCalled())
    // rasterizeSvgToPng creates its own intermediate object URL (the
    // rendered SVG fed into a real <img>) ahead of the final downloaded
    // blob, so the last captured blob is the one under test here.
    const blob = blobs[blobs.length - 1]!
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBeGreaterThan(0)
  })

  // The menu must only offer formats `exportScene` (SceneExportFormat) can
  // actually produce — an entry outside that union is an affordance whose
  // every click fails.
  it('never renders a JSON/Excalidraw export menu item', async () => {
    await renderLoaded()
    fireEvent.pointerDown(screen.getByLabelText('Canvas actions'), {
      button: 0,
      ctrlKey: false,
    })
    await waitFor(() => expect(screen.getByText('Export as PNG')).toBeInTheDocument())

    expect(screen.queryByText(/json|excalidraw/i)).toBeNull()
  })
})
