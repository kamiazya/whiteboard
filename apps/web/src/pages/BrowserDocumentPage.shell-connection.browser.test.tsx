import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppShell } from '../components/AppShell.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { resetShellStatusForTests } from '../lib/shell-status-store.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
// Real app styles so the chip is laid out the way it ships.
import '../index.css'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

// The claim seeds the db-name seam every opener in this page resolves;
// nothing here needs the name itself now that clearWhiteboardDb reads it.
claimIsolatedWhiteboardDb('browserdocumentpage-shell-connection')

// The composition main.tsx ships: the shell above the routed page, both in one
// router. Neither half proves this on its own — the page publishes a state it
// does not draw, and the shell draws a state it does not know.
function renderApp() {
  return rtlRender(
    <div style={{ height: '100vh' }}>
      <MemoryRouter initialEntries={['/w/default/d/c1']}>
        <div className="flex h-dvh flex-col">
          <AppShell daemon={false} />
          <div className="min-h-0 flex-1">
            <BrowserDocumentPage store={new IdbDocumentIndex()} />
          </div>
        </div>
      </MemoryRouter>
    </div>,
  )
}

describe('shell mark over a real document kept in this browser', () => {
  beforeEach(async () => {
    resetShellStatusForTests()
    await clearWhiteboardDb()
  })

  afterEach(() => {
    cleanup()
    resetShellStatusForTests()
  })

  it('the open document lights the shell chip, whose popover carries the daemon CTA', async () => {
    renderApp()
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )

    const mark = await waitFor(() => screen.getByTestId('shell-mark-trigger'), { timeout: 5000 })
    // The mark carries the keeper as a tone, so the WORD lives in the
    // accessible name rather than in chrome — which is what makes the state
    // readable to assistive tech that cannot see a colour.
    expect(mark.getAttribute('aria-label')).toMatch(/browser/i)
    expect(screen.getByTestId('shell-mark-cap').getAttribute('data-tone')).toBe('neutral')
    // The mark sits in the shell's own row, not inside the document's top bar
    // — that separation is the whole point of the move, and a DOM assertion is
    // the only thing that can tell the two rows apart.
    expect(mark.closest('header')?.querySelector('[data-testid="shell-settings"]')).toBeTruthy()

    // Sentence-length copy stays out of chrome: it appears only once opened.
    expect(screen.queryByText(/other browsers cannot see them/i)).toBeNull()
    fireEvent.click(mark)
    expect(await screen.findByText(/other browsers cannot see them/i)).toBeInTheDocument()
    expect(
      await screen.findByText(/Connect a daemon \(MCP\) for automatic checkpoints/i),
    ).toBeInTheDocument()
  })

  it('leaving the document takes the claim with it', async () => {
    renderApp()
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
    await waitFor(() => expect(screen.getByTestId('shell-mark-trigger')).toBeInTheDocument(), {
      timeout: 5000,
    })

    // The shell outlives the page in production, so the page unmounting is
    // exactly what must clear the state — a latched mark would keep telling
    // an index page it is holding a session.
    cleanup()
    rtlRender(
      <MemoryRouter initialEntries={['/']}>
        <AppShell daemon={false} />
      </MemoryRouter>,
    )
    // The CLAIM, not the control: the mark is the workspace switcher and
    // stays on every page. What must clear is the keeper paint it was
    // carrying for the document that just went away.
    expect(screen.getByTestId('shell-mark-trigger')).toBeInTheDocument()
    expect(screen.getByTestId('shell-mark').getAttribute('data-keeper')).toBeNull()
  })
})
