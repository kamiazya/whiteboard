// The seam between the three parts: the canvas raises the verb, the page owns
// the surface, and the edit has to land back in the canvas. Each part has its
// own test; only the page can answer whether they are connected.

// jsdom + fake-indexeddb: this suite drives page wiring over IndexedDB
// persistence with the spatial editor mocked — no browser layout or input
// fidelity at stake. The real-IDB contract stays pinned by the four
// browser-mode keeper suites (see loro-store.browser.test.tsx).
import 'fake-indexeddb/auto'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'

claimIsolatedWhiteboardDb('browserdocumentpage-open-in-editor')

type OnChange = (next: SpatialCanvas, command: unknown) => void
type OpenInEditor = (nodeId: string, text: string) => void

const NODE_TEXT = '# Plan\n\n- one'
let latestOnChange: OnChange | null = null

// The real canvas needs geometry this test does not care about; what it must
// do here is offer the verb the way the real one does, with the node's text.
vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (props: { onChange?: OnChange; onOpenInEditor?: OpenInEditor }) => {
    latestOnChange = props.onChange ?? null
    return (
      <button type="button" onClick={() => props.onOpenInEditor?.('n1', NODE_TEXT)}>
        raise open-in-editor
      </button>
    )
  },
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')

describe('open in editor (page seam)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    latestOnChange = null
  })

  afterEach(() => {
    window.localStorage.removeItem('whiteboard.markdown-view-mode')
  })

  it("opens the page's editing surface on the node body the canvas hands over", async () => {
    const store = new IdbDocumentIndex()
    await seedIdbDocument(store, {
      path: 'board',
      name: 'Board',
      kind: 'spatial',
      makeDefault: true,
    })
    render(
      <MemoryRouter>
        <BrowserDocumentPage store={store} />
      </MemoryRouter>,
    )

    // The canvas raises the verb; the page has to answer with the surface,
    // carrying the text the canvas handed over. What the commit WRITES is
    // `withNodeText`'s own test — the page's canvas arrives through the CRDT
    // sync hook, so a write is not observable from here.
    await waitFor(() => expect(latestOnChange).not.toBeNull(), { timeout: 10_000 })
    // fireEvent, not userEvent: the stub button sits in a zero-height slot,
    // and playwright's actionability wait would never call it stable.
    fireEvent.click(await screen.findByRole('button', { name: 'raise open-in-editor' }))

    const overlay = await screen.findByTestId('node-text-overlay')
    await waitFor(() => expect(overlay.querySelector('.cm-content')).not.toBeNull())
    expect(overlay.querySelector('.cm-content')?.textContent).toContain('# Plan')

    fireEvent.click(await screen.findByRole('button', { name: 'Back to canvas' }))
    await waitFor(() => expect(screen.queryByTestId('node-text-overlay')).toBeNull())
  })
})
