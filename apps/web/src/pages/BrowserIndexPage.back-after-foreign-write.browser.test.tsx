/**
 * A Back that returns to this still-mounted page re-reads a write the page
 * did not make itself.
 *
 * Two triggers re-read the list on a page that never unmounts, and they
 * cover different writes. `filesRevision` follows this page's OWN create,
 * and its sibling file `BrowserIndexPage.back-during-load` drives exactly
 * that. `revision` — the location object App hands down, whose identity is
 * new on every navigation — follows the ROUTE returning here, and is the
 * only one that can see a write made behind the page's back.
 *
 * Nothing held it. Measured 2026-09-12: with `revision={location}` deleted
 * from App, `web-jsdom` reported 381 files / 3,924 tests passing and the
 * sibling browser file passed too, because its create is the page's own.
 * Seeding the document straight through the index is what separates the
 * two triggers.
 *
 * The editor module is mocked behind a GATE rather than a delay. The window
 * the bug lives in is "the chunk has not landed yet", which is a condition,
 * and a fixed sleep is a window that can close before the Back — under the
 * full parallel run a web-browser test measures many times its isolated
 * time (.claude/rules/integrator-flow.md), so the test would pass over a
 * case it never reached. The gate also lets the chunk land INSIDE the test,
 * so no module request outlives it.
 */

import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { documentPath } from '../lib/app-routes.js'
import { BROWSER_DEFAULT_SEGMENT } from '../lib/browser-idb.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { idbContentClock } from '../lib/local-document-summary.js'
import { LoroStore } from '../lib/loro-store.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { createSeededDocument } from './use-browser-document-controller.js'

claimIsolatedWhiteboardDb('browserindexpage-backforeignwrite')

const editorChunk = vi.hoisted(() => {
  let land: () => void = () => {}
  const landed = new Promise<void>((resolve) => {
    land = resolve
  })
  return { landed, land: (): void => land() }
})

vi.mock('./BrowserDocumentPage.js', async () => {
  await editorChunk.landed
  return {
    BrowserDocumentPage: () => <div data-testid="delayed-editor" />,
  }
})

const { App } = await import('../App.js')

function renderApp(initial: string) {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], {
    initialEntries: [initial],
  })
  rtlRender(
    <div style={{ height: '100vh' }}>
      <RouterProvider router={router} />
    </div>,
  )
  return router
}

beforeEach(async () => {
  await clearWhiteboardDb()
})

afterEach(async () => {
  // Never leave the factory unresolved. `resolveManualMock` is the RPC that
  // AWAITS it, so it is in flight for exactly as long as the factory is, and
  // a browser page closing under one fails the whole FILE with
  // VITEST_BROWSER_CONNECTION_CLOSED — naming no test and no cause. That is
  // a factory that outlives its test body breaks CI even when every test in
  // the file PASSED. Landing here covers the path the test body cannot: the
  // one where an assertion failed on the way, where an unattributable
  // file-level crash would otherwise replace the message naming what broke.
  editorChunk.land()
  await editorChunk.landed
  cleanup()
})

it('Back after a write this page did not make lists it', async () => {
  const router = renderApp('/')
  await screen.findByText('What will you make first?', undefined, { timeout: 15_000 })

  // Written straight through the index, so this page's own `filesRevision`
  // never moves — the whole point of the case.
  const created = await createSeededDocument(
    new IdbDocumentIndex(),
    new LoroStore(),
    idbContentClock(),
  )
  expect(screen.queryByTestId('card-title')).toBeNull()

  // Leave for the editor and come back inside the chunk-load window, so the
  // page is never unmounted and only `revision` can tell it to re-read.
  await router.navigate(documentPath(BROWSER_DEFAULT_SEGMENT, created.path))
  await waitFor(() => expect(router.state.location.pathname).toMatch(/\/d\//), {
    timeout: 15_000,
  })
  await router.navigate(-1)

  const titles = await screen.findAllByTestId('card-title', undefined, { timeout: 15_000 })
  expect(titles.length).toBeGreaterThan(0)
  expect(screen.queryByText('What will you make first?')).toBeNull()

  // Land the chunk inside the test, and prove it landed — see the header.
  editorChunk.land()
  await router.navigate(1)
  await screen.findByTestId('delayed-editor', undefined, { timeout: 15_000 })
})
