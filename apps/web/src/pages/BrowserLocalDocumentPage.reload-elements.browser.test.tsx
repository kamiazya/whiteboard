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

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { act, cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorCommand } from '../components/spatial-editor/commands.js'
import { IndexedDBStore } from '../lib/browser-local-store.js'
import {
  clearWhiteboardDb,
  loroDocumentsKeys,
  setTextCommand,
  textNodeCanvas,
} from '../test-utils/browser-local-document.js'
import '../index.css'

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
    render(<BrowserLocalDocumentPage store={new IndexedDBStore()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 5000 })

    const next = textNodeCanvas('reload-regression-node', 10, 10)

    // The backend connects asynchronously after the editing state mounts, and
    // there is no synchronous "connected" signal to await. Re-fire the same
    // (idempotent) edit on each poll so a change dispatched before the
    // connection settles is retried until it lands, then wait for the debounce
    // (300ms) to flush the write into the real canvas row (not '__placeholder__').
    await waitFor(
      async () => {
        act(() => {
          latestOnChange!(next, setTextCommand('reload-regression-node'))
        })
        const keys = await loroDocumentsKeys()
        expect(keys.length).toBeGreaterThan(0)
      },
      { timeout: 10000, interval: 600 },
    )

    const keysAfterDraw = await loroDocumentsKeys()
    expect(keysAfterDraw).not.toContain('__placeholder__')

    cleanup()
    latestMountedCanvases = []
    render(<BrowserLocalDocumentPage store={new IndexedDBStore()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )

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
