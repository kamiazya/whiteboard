import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { newImageRef, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import shippedHeaders from '../../public/_headers?raw'
import { DocumentFileStore } from '../lib/document-file-store.js'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { LoroStore } from '../lib/loro-store.js'
import { extractTextFromPng } from '../lib/png-embed.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
import '../index.css'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'

// The claim seeds the db-name seam every opener in this page resolves;
// nothing here needs the name itself now that clearWhiteboardDb reads it.
claimIsolatedWhiteboardDb('browserdocumentpage-export')

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
  renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)
  await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(), {
    timeout: 5000,
  })
}

/** The page on a markdown note: loaded once its source pane has mounted. */
async function renderNoteLoaded(): Promise<void> {
  renderPage(<BrowserDocumentPage store={new FoldingBrowserIndex()} />)
  await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull(), {
    timeout: 10_000,
  })
}

// Export moved into the canvas row's "More actions" kebab (the canvas-level
// operations home). Opening a Radix dropdown occasionally does not register
// on the first pointerdown the first time in a given real-browser test file
// (never reproduces in jsdom) — retry with a full remount rather than let
// that tooling artifact fail a real behavioral assertion.
async function openExportMenuItem(
  label: string,
  remount: () => Promise<void> = renderLoaded,
): Promise<HTMLElement> {
  let item: HTMLElement | undefined
  for (let attempt = 0; attempt < 8 && !item; attempt++) {
    if (attempt > 0) {
      cleanup()
      await remount()
    }
    const allKebabs = await waitFor(() => screen.getAllByLabelText('More actions'), {
      timeout: 5000,
    })
    const kebab = allKebabs[allKebabs.length - 1]!
    fireEvent.pointerDown(kebab, { button: 0, ctrlKey: false })
    try {
      // The formats sit behind one `Export…` row now; Radix opens a submenu
      // on pointerMove over its trigger (hover intent).
      const triggers = await waitFor(() => screen.getAllByText('Export…'), { timeout: 1500 })
      fireEvent.pointerMove(triggers[triggers.length - 1]!, { pointerType: 'mouse' })
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

describe('BrowserDocumentPage export (browser — real SpatialEditor, no Excalidraw)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
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

    // Editable PNG: the file carries its own JSON Canvas document (the
    // draw.io pattern), so a shared export IS the canvas — coordinates
    // included — not just pixels of it.
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const embedded = extractTextFromPng(bytes, 'whiteboard')
    expect(embedded).not.toBeNull()
    const parsed = JSON.parse(embedded as string) as { nodes: { id: string }[] }
    expect(Array.isArray(parsed.nodes)).toBe(true)
  })

  it('says the PNG went out, in the status region', async () => {
    await renderLoaded()
    captureExportedBlobs()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    fireEvent.pointerUp(await openExportMenuItem('Export as PNG'))

    await waitFor(() => expect(clickSpy).toHaveBeenCalled(), { timeout: EXPORT_TIMEOUT_MS })
    await waitFor(() =>
      expect(screen.getByText('Exported as PNG', { selector: '[role="status"]' })).toBeTruthy(),
    )
  })

  // Export DOWNLOADS must only offer formats `exportScene`
  // (SceneExportFormat) can actually produce — a download entry outside
  // that union is an affordance whose every click fails. Copy as JSON
  // Canvas is a clipboard action, not a download, and is exempt.
  it('never renders a JSON/Excalidraw export download entry', async () => {
    await renderLoaded()
    fireEvent.pointerDown(screen.getByLabelText('More actions'), {
      button: 0,
      ctrlKey: false,
    })
    // Open the formats submenu: what this asserts is about the formats
    // OFFERED, so it has to look where they are.
    fireEvent.pointerMove(await screen.findByText('Export…'), { pointerType: 'mouse' })
    await waitFor(() => expect(screen.getByText('Export as PNG')).toBeInTheDocument())

    expect(screen.queryByText(/excalidraw/i)).toBeNull()
    expect(screen.queryByText(/export as json/i)).toBeNull()
  })
})

/** The pixel width a PNG's header declares. */
function pngWidth(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(16)
}

describe('BrowserDocumentPage export options', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('fills the SVG with the paper by default, and leaves it transparent once the option is off', async () => {
    await renderLoaded()
    expect(await exportSvgText()).toContain('role="presentation"')

    cleanup()
    vi.restoreAllMocks()
    await renderLoaded()
    fireEvent.pointerUp(await openExportMenuItem('With background'))
    cleanup()
    await renderLoaded()
    expect(await exportSvgText()).not.toContain('role="presentation"')
  })

  it('rasterises a PNG twice as wide once 2× resolution is on', async () => {
    const widthOfPng = async (): Promise<number> => {
      const { blobs } = captureExportedBlobs()
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      fireEvent.pointerUp(await openExportMenuItem('Export as PNG'))
      await waitFor(() => expect(clickSpy).toHaveBeenCalled(), { timeout: EXPORT_TIMEOUT_MS })
      return pngWidth(new Uint8Array(await blobs[blobs.length - 1]!.arrayBuffer()))
    }
    await renderLoaded()
    const at1x = await widthOfPng()
    cleanup()
    vi.restoreAllMocks()

    await renderLoaded()
    fireEvent.pointerUp(await openExportMenuItem('2× resolution (PNG)'))
    cleanup()
    await renderLoaded()
    expect(await widthOfPng()).toBe(at1x * 2)
  })
})

/** Seeds a document's content through the same store the page loads it from. */
async function seedContent(documentId: string, write: (doc: Loro) => void): Promise<void> {
  const doc = new Loro()
  write(doc)
  await new LoroStore().save(documentId, doc.export({ mode: 'snapshot' }))
}

/** Exports SVG through the menu and answers the downloaded document's text. */
async function exportSvgText(remount?: () => Promise<void>): Promise<string> {
  const { blobs } = captureExportedBlobs()
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  fireEvent.pointerUp(await openExportMenuItem('Export as SVG', remount))
  await waitFor(() => expect(clickSpy).toHaveBeenCalled(), { timeout: EXPORT_TIMEOUT_MS })
  const blob = blobs[blobs.length - 1]
  expect(blob?.type).toBe('image/svg+xml')
  return (await blob?.text()) ?? ''
}

/** A real PNG, drawn rather than hand-encoded, so the bytes decode. */
async function redPng(): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 40
  canvas.height = 30
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('no 2D context')
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 40, 30)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('toBlob produced nothing')
  return blob
}

/**
 * The deployed page's `connect-src`, enforced on this one: the test page has
 * no policy of its own, and the export reads pictures under the one the app
 * ships with — a fetch of a `blob:` URL passed here and failed in the app.
 * A meta policy cannot be lifted once set, which is fine for the rest of
 * this file: nothing below fetches anything the shipped policy refuses.
 */
function enforceShippedConnectPolicy(): void {
  const policy = shippedHeaders
    .split('\n')
    .find((line) => line.trim().startsWith('Content-Security-Policy:'))
  const connect = policy
    ?.split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('connect-src '))
  if (connect === undefined) throw new Error('no connect-src in the shipped _headers')
  const meta = document.createElement('meta')
  meta.httpEquiv = 'Content-Security-Policy'
  meta.content = connect
  document.head.append(meta)
}

function editorSurfaceText(): string {
  return screen.getByTestId('spatial-editor-container').textContent ?? ''
}

describe('BrowserDocumentPage export draws what the screen shows', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('a markdown note exports its body, not an empty 1x1 picture', async () => {
    const noteId = await seedIdbDocument({ path: 'note', kind: 'markdown', makeDefault: true })
    await seedContent(noteId, (doc) => {
      doc.getText('body').insert(0, '# Exportedheading\n\nSome exported prose.\n')
    })
    await renderNoteLoaded()

    const svg = await exportSvgText(renderNoteLoaded)
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
    expect(root.textContent).toContain('Exportedheading')
    expect(Number(root.getAttribute('width'))).toBeGreaterThan(1)
    expect(Number(root.getAttribute('height'))).toBeGreaterThan(1)
  })

  it('a stored image exports as inline bytes, not its asset id', async () => {
    const ref = newImageRef(crypto.randomUUID())
    await new DocumentFileStore().put(ref, {
      mimeType: 'image/png',
      blob: await redPng(),
      created: Date.now(),
    })
    const boardId = await seedIdbDocument({ path: 'board', makeDefault: true })
    const board: SpatialCanvas = {
      nodes: [fileNode({ id: 'pic', x: 0, y: 0, width: 240, height: 180, file: ref })],
      edges: [],
    }
    await seedContent(boardId, (doc) => writeSpatialCanvas(doc, board))
    enforceShippedConnectPolicy()
    await renderLoaded()
    // The editor has the picture before the export is asked for it.
    await waitFor(
      () => {
        const image = document.querySelector('[data-testid="spatial-editor-container"] image')
        expect(image?.getAttribute('href')).toMatch(/^blob:/)
      },
      { timeout: 10_000 },
    )

    const svg = await exportSvgText()
    expect(svg).toMatch(/<image [^>]*href="data:image\/png;base64,/)
    expect(svg).not.toContain('blob:')
    expect(svg).not.toContain('asset:')
  })

  it('a file node exports the note it points at, as the editor draws it', async () => {
    const noteId = await seedIdbDocument({ path: 'pointed-note', kind: 'markdown' })
    await seedContent(noteId, (doc) => {
      doc.getText('body').insert(0, 'Unmistakablefilebody prose.\n')
    })
    const boardId = await seedIdbDocument({ path: 'board', makeDefault: true })
    const board: SpatialCanvas = {
      nodes: [fileNode({ id: 'ref', x: 0, y: 0, width: 320, height: 200, file: noteId })],
      edges: [],
    }
    await seedContent(boardId, (doc) => writeSpatialCanvas(doc, board))
    await renderLoaded()
    await waitFor(() => expect(editorSurfaceText()).toContain('Unmistakablefilebody'), {
      timeout: 10_000,
    })

    const svg = await exportSvgText()
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
    expect(root.textContent).toContain('Unmistakablefilebody')
  })
})
