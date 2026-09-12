/**
 * Back during the editor chunk's load must not resurrect onboarding.
 *
 * react-router v7 wraps navigations in startTransition, so while the lazy
 * editor's chunk loads, the index page stays MOUNTED under the old
 * location. A Back in that window aborts the transition — the page is never
 * unmounted, its load effect never re-runs, and it kept showing the
 * pre-create empty state over a workspace holding the document.
 *
 * TWO triggers re-read that list on the never-unmounted page, and they cover
 * different writes. This file creates through the page's own button, so what
 * it holds is `filesRevision`. App's `revision={location}` is the other one,
 * and only a write made behind the page's back separates them — measured
 * 2026-09-12: with `revision={location}` deleted, this file stayed green and
 * `web-jsdom` reported 381 files / 3,924 tests passing. Its sibling
 * `BrowserIndexPage.back-after-foreign-write` is what holds that one.
 *
 * The editor module is mocked behind a GATE rather than a delay, for two
 * reasons that both cost a real failure:
 *
 * - The window the bug lives in is "the chunk has not landed yet", which is
 *   a condition. A fixed sleep is a window that can close before the Back —
 *   under the full parallel run a web-browser test measures many times its
 *   isolated time (.claude/rules/integrator-flow.md) — and the test then
 *   passes over a case it never reached.
 * - `resolveManualMock` is the RPC that AWAITS the factory, so it is in
 *   flight for exactly as long as the factory is. A page closing under one
 *   fails the whole FILE with VITEST_BROWSER_CONNECTION_CLOSED, naming no
 *   test and no cause. That is what the old 1500ms sleep did to CI while its
 *   own test PASSED in 1821ms: the body finished, the file ended, and the
 *   sleep was still running.
 */

import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserindexpage-backduringload')

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

function renderApp() {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], {
    initialEntries: ['/'],
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
  // Never leave the factory unresolved — see the header. This covers the
  // path the test body cannot: the one where an assertion failed on the way,
  // where an unattributable file-level crash would otherwise replace the
  // message naming what actually broke.
  editorChunk.land()
  await editorChunk.landed
  cleanup()
})

it('Back before the editor chunk lands still lists the created document', async () => {
  const router = renderApp()

  await screen.findByText('What will you make first?', undefined, { timeout: 15_000 })
  await userEvent.click(screen.getByRole('button', { name: /canvas/i }))

  // The create lands and the navigation starts; Back while the chunk is
  // still gated shut, BEFORE the editor module resolves.
  await waitFor(() => expect(router.state.location.pathname).toMatch(/\/d\//), {
    timeout: 15_000,
  })
  await router.navigate(-1)

  const titles = await screen.findAllByTestId('card-title', undefined, { timeout: 15_000 })
  expect(titles.length).toBeGreaterThan(0)
  expect(screen.queryByText('What will you make first?')).toBeNull()

  // Land the chunk inside the test, and prove it landed, so nothing this
  // file started is still in flight when the page closes.
  editorChunk.land()
  await router.navigate(1)
  await screen.findByTestId('delayed-editor', undefined, { timeout: 15_000 })
})
