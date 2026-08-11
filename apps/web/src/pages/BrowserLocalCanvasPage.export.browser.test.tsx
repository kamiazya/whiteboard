import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import { BrowserLocalCanvasPage } from './BrowserLocalCanvasPage.js'
import '../index.css'

function render(ui: ReactElement) {
  return rtlRender(
    // Pages fill their allotted height (h-full) — the app shell owns the
    // viewport in production, so tests supply the equivalent sized parent.
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
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

// Export moved into the canvas row's "More actions" kebab (the canvas-level
// operations home). Opening a Radix dropdown occasionally does not register
// on the first pointerdown the first time in a given real-browser test file
// (never reproduces in jsdom) — retry with a full remount rather than let
// that tooling artifact fail a real behavioral assertion.
async function openExportMenuItem(label: string): Promise<HTMLElement> {
  let item: HTMLElement | undefined
  for (let attempt = 0; attempt < 8 && !item; attempt++) {
    if (attempt > 0) {
      cleanup()
      await renderLoaded()
    }
    const allKebabs = await waitFor(() => screen.getAllByLabelText('More actions'), {
      timeout: 5000,
    })
    const kebab = allKebabs[allKebabs.length - 1]!
    fireEvent.pointerDown(kebab, { button: 0, ctrlKey: false })
    try {
      const allItems = await waitFor(() => screen.getAllByText(label), { timeout: 1500 })
      item = allItems[allItems.length - 1]!
    } catch {
      // retry with a fresh remount
    }
  }
  if (!item) throw new Error(`More actions kebab never opened after retries (${label})`)
  return item
}

/**
 * Budget for an export to reach the download anchor. This is NOT papering
 * over a race: the wait is already on the terminal signal (the anchor
 * click), and the work in between is irreducibly asynchronous — lay out the
 * scene, serialise SVG, and for PNG additionally decode it through a real
 * <img> and encode a bitmap via canvas.toBlob. testing-library's default
 * 1000ms was simply too small a budget for that on a loaded CI runner, and
 * the PNG case (the heaviest of the two) is what failed there on
 * 2026-08-09. The rest of this file already uses explicit budgets for the
 * same reason.
 */
const EXPORT_TIMEOUT_MS = 15_000

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

    await waitFor(() => expect(clickSpy).toHaveBeenCalled(), { timeout: EXPORT_TIMEOUT_MS })
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

    await waitFor(() => expect(clickSpy).toHaveBeenCalled(), { timeout: EXPORT_TIMEOUT_MS })
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
    fireEvent.pointerDown(screen.getByLabelText('More actions'), {
      button: 0,
      ctrlKey: false,
    })
    await waitFor(() => expect(screen.getByText('Export as PNG')).toBeInTheDocument())

    expect(screen.queryByText(/json|excalidraw/i)).toBeNull()
  })
})
