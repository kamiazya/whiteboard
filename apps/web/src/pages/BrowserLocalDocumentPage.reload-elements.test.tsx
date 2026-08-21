/**
 * Reload-loses-elements regression (real IndexedDB).
 *
 * Root cause: useDocumentSync connected once to whichever backend it was first
 * given, then never reconnected — so BrowserLocalDocumentPage's placeholder
 * backend (used while the initial snapshot loads) stayed connected forever
 * and the real per-canvas backend's writes never happened. Nodes drawn
 * before the initial load settled were silently dropped, and a stray
 * '__placeholder__' row accumulated in IndexedDB.
 *
 * SpatialEditor is mocked here (unlike BrowserLocalDocumentPage.browser.test.tsx)
 * so the test can drive a scene change deterministically via onChange instead
 * of simulating a pointer gesture — SpatialEditor has no create-node gesture
 * to drive one with yet, and this suite's actual subject is the
 * backend/IndexedDB sync layer underneath, which remains real.
 */

// jsdom + fake-indexeddb: this suite drives page wiring over IndexedDB
// persistence with the spatial editor mocked — no browser layout or input
// fidelity at stake. The real-IDB contract stays pinned by the four
// browser-mode keeper suites (see loro-store.browser.test.tsx).
import 'fake-indexeddb/auto'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import {
  clearWhiteboardDb,
  loroDocumentsKeys,
  persistedNodeIds,
  setTextCommand,
  textNodeCanvas,
} from '../test-utils/browser-local-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserlocaldocumentpage-reload-elements')

// The page reads/writes the canvas id through the router, so it needs a router
// in scope exactly as it has one in main.tsx.
function render(ui: ReactElement) {
  return rtlRender(
    // Pages fill their allotted height (h-full) — the app shell owns the
    // viewport in production, so tests supply the equivalent sized parent.
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>
    </div>,
  )
}

type OnChange = (next: SpatialCanvas, command: EditorCommand) => void

let latestOnChange: OnChange | null = null
let latestMountedCanvases: SpatialCanvas[] = []

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (props: { canvas: SpatialCanvas; onChange?: OnChange }) => {
    latestOnChange = props.onChange ?? null
    latestMountedCanvases.push(props.canvas)
    return null
  },
}))

const { BrowserLocalDocumentPage } = await import('./BrowserLocalDocumentPage.js')

// These suites came from browser mode, where the per-test budget is 60s, and
// kept their 10s waits when they moved to jsdom — whose default is 5s, so a
// wait that actually has to wait can never finish inside its own test. Not
// theoretical: content persistence now goes through the `DocumentStore` port,
// which costs two to three IndexedDB round trips where it used to cost one,
// and `fake-indexeddb` is slower per round trip than the real thing.
vi.setConfig({ testTimeout: 30_000 })

describe('BrowserLocalDocumentPage reload persistence (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    latestOnChange = null
    latestMountedCanvases = []
  })

  afterEach(() => {
    cleanup()
  })

  it('persists a node across remount and never writes a __placeholder__ row', async () => {
    render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy(), {
      timeout: 5000,
    })
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })

    const next = textNodeCanvas('reload-regression-node', 10, 10)

    // The backend connects asynchronously after the editing state mounts, and
    // there is no synchronous "connected" signal to await. Re-fire the same
    // (idempotent) edit on each poll so a change dispatched before the
    // connection settles is retried until it lands, then wait for the debounce
    // (300ms) to flush the write into the real canvas row (not '__placeholder__').
    //
    // Waits on the record's CONTENT, not on a record existing. Every create
    // path now seeds an empty content record, so "a key is present" is true
    // before any edit lands — a poll on that stops retrying immediately and
    // the remount below then reads an empty canvas. Measured: the wait passed
    // and the assertion after the remount got `[]`.
    const [documentId] = await loroDocumentsKeys()
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(next, setTextCommand('reload-regression-node'))
        })
        expect(await persistedNodeIds(documentId as string)).toContain('reload-regression-node')
      },
      { timeout: 10000, interval: 600 },
    )

    const keysAfterDraw = await loroDocumentsKeys()
    expect(keysAfterDraw).not.toContain('__placeholder__')

    cleanup()
    latestMountedCanvases = []
    render(<BrowserLocalDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(() => expect(screen.getByTestId('spatial-editor-container')).toBeTruthy(), {
      timeout: 5000,
    })

    // The restored scene must include the node written before remount.
    await waitFor(
      () => {
        const restoredIds = latestMountedCanvases.flatMap((canvas) => canvas.nodes.map((n) => n.id))
        expect(restoredIds).toContain('reload-regression-node')
      },
      { timeout: 5000 },
    )

    const keysAfterRemount = await loroDocumentsKeys()
    expect(keysAfterRemount).not.toContain('__placeholder__')
  })
})
