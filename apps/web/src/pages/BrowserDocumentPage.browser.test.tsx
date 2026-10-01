import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { IdbDefaultDocumentPointer, listLocalDocuments } from '../lib/local-document-summary.js'
import { BrowserDocumentPage } from './BrowserDocumentPage.js'
// Real app styles so layout assertions measure the shipped geometry.
import '../index.css'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { renderPage } from '../test-utils/daemon-page-harness.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

// The claim seeds the db-name seam every opener in this page resolves;
// nothing here needs the name itself now that clearWhiteboardDb reads it.
claimIsolatedWhiteboardDb('browserdocumentpage')

// The page reads/writes the canvas id through the router, so it needs a router
// in scope exactly as it has one in main.tsx.
describe('BrowserDocumentPage (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  afterEach(() => {
    cleanup()
  })

  it('load: renders spatial editor container after initial load', async () => {
    renderPage(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
  })

  it('layout: spatial editor container fills the viewport below the header', async () => {
    // An unsized height chain collapses the container to 0px and the whiteboard
    // becomes invisible. The page must own its viewport height so the editor
    // area gets real geometry.
    renderPage(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
    const container = screen.getByTestId('spatial-editor-container')
    // Viewport is 1280x900; the editor area must occupy most of it.
    expect(container.clientHeight).toBeGreaterThan(300)
    expect(container.clientWidth).toBeGreaterThan(600)
  })

  it('layout: the editor area is never clipped below the viewport, whatever the header stacks', async () => {
    // Regression: the old flex column let a growing/wrapping header push the
    // editor's bottom edge past the viewport. The grid shell gives the
    // header stack an auto row and the editor minmax(0,1fr) — the editor's
    // bottom must sit exactly at the viewport's bottom edge.
    renderPage(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      { timeout: 5000 },
    )
    const container = screen.getByTestId('spatial-editor-container')
    const rect = container.getBoundingClientRect()
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 1)
    // And it truly fills the remainder — no dead strip above the fold.
    expect(rect.bottom).toBeGreaterThan(window.innerHeight - 2)

    // The actual regression: GROW the header stack (as a wrapping row or an
    // appearing banner would) and the editor must give up exactly that
    // height instead of sliding its bottom edge below the viewport.
    const headerStack = container.closest('main')?.firstElementChild as HTMLElement
    const filler = document.createElement('div')
    filler.style.height = '120px'
    headerStack.appendChild(filler)
    try {
      const grown = container.getBoundingClientRect()
      expect(grown.bottom).toBeLessThanOrEqual(window.innerHeight + 1)
      expect(grown.height).toBeLessThan(rect.height)
    } finally {
      filler.remove()
    }
  })

  it('layout: respects the height its parent allots (app-level banner scenario)', async () => {
    // The phone bug: the app shell stacks a beta banner ABOVE the page, so
    // the page must size to the remaining height (h-full). A page that
    // claims the whole viewport (h-dvh) under an in-flow banner slides its
    // bottom — the tool palette — past the viewport edge.
    const BANNER_PX = 40
    rtlRender(
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: BANNER_PX, flexShrink: 0 }} />
        <div style={{ minHeight: 0, flex: 1, overflow: 'hidden' }}>
          <MemoryRouter initialEntries={['/']}>
            <BrowserDocumentPage store={new IdbDocumentIndex()} />
          </MemoryRouter>
        </div>
      </div>,
    )
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      { timeout: 5000 },
    )
    const container = screen.getByTestId('spatial-editor-container')
    const rect = container.getBoundingClientRect()
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight + 1)
    const main = container.closest('main') as HTMLElement
    expect(main.getBoundingClientRect().height).toBeLessThanOrEqual(
      window.innerHeight - BANNER_PX + 1,
    )
  })

  it('delete: the last canvas gives way to a fresh one, which survives a remount', async () => {
    const store = new IdbDocumentIndex()
    renderPage(<BrowserDocumentPage store={store} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
    const deletedIds = (await listLocalDocuments(store)).map((doc) => doc.documentId)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), { button: 0 })
    fireEvent.pointerUp(await screen.findByRole('menuitem', { name: /^delete$/i }))
    const dialog = await screen.findByRole('alertdialog', undefined, { timeout: 5000 })
    within(dialog)
      .getByRole('button', { name: /^delete$/i })
      .click()
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), { timeout: 5000 })
    // The editor stays on screen through the switch, so it proves nothing; the
    // store holding only a fresh row is what says the delete has finished.
    await waitFor(
      async () => {
        const ids = (await listLocalDocuments(store)).map((doc) => doc.documentId)
        expect(ids).toHaveLength(1)
        expect(deletedIds).not.toContain(ids[0])
      },
      { timeout: 5000 },
    )
    cleanup()
    renderPage(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
  })

  // A pointer outliving its document — a delete whose repoint had not landed,
  // another tab's delete — is not unreadable data; it names nothing. The page
  // opens what is left, as a delete does, rather than an error screen whose
  // only way out is "Start fresh".
  it('open: a pointer naming a deleted document opens what is left', async () => {
    const store = new IdbDocumentIndex()
    renderPage(<BrowserDocumentPage store={store} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      { timeout: 5000 },
    )
    const [kept] = await listLocalDocuments(store)
    cleanup()
    await new IdbDefaultDocumentPointer().set('01ZZZZZZZZZZZZZZZZZZZZZZZZ')

    renderPage(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      { timeout: 5000 },
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(await new IdbDefaultDocumentPointer().get()).toBe(kept?.documentId)
  })

  it('network-negative: no fetch to /api/ or daemon endpoints during editing', async () => {
    const calls: string[] = []
    const original = window.fetch.bind(window)
    const spy = vi.spyOn(window, 'fetch').mockImplementation((...args) => {
      const url =
        typeof args[0] === 'string'
          ? args[0]
          : args[0] instanceof URL
            ? args[0].href
            : (args[0] as Request).url
      calls.push(url)
      return original(...args)
    })
    renderPage(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
    // Wait a bit to catch any delayed fetch calls from async init.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const daemonCalls = calls.filter(
      (url) => url.includes('/api/') || url.includes('localhost:3') || url.includes('127.0.0.1'),
    )
    expect(daemonCalls).toHaveLength(0)
    spy.mockRestore()
  })

  it('does not render an "Add rectangle" button', async () => {
    renderPage(<BrowserDocumentPage store={new IdbDocumentIndex()} />)
    await waitFor(
      () => expect(screen.getByTestId('spatial-editor-container')).toBeInTheDocument(),
      {
        timeout: 5000,
      },
    )
    expect(screen.queryByRole('button', { name: /add rectangle/i })).toBeNull()
  })
})
