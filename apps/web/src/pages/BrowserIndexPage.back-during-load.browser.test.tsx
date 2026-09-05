/**
 * Back during the editor chunk's load must not resurrect onboarding.
 *
 * react-router v7 wraps navigations in startTransition, so while the lazy
 * editor's chunk loads, the index page stays MOUNTED under the old
 * location. A Back in that window aborts the transition — the page is never
 * unmounted, its load effect never re-runs, and it kept showing the
 * pre-create empty state over a workspace holding the document. App now
 * hands the page the location object as `revision` (identity moves on every
 * navigation, where location.key is per-entry and a Back restores the same
 * one), and the page re-reads on it.
 *
 * The editor module is mocked with a DELAYED factory: the delay IS the
 * chunk-load window the real bug lived in, made deterministic.
 */

import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserindexpage-backduringload')

vi.mock('./BrowserDocumentPage.js', async () => {
  // The window the real bug lived in: the chunk is still loading when the
  // Back below is issued.
  await new Promise((resolve) => setTimeout(resolve, 1500))
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

afterEach(() => {
  cleanup()
})

it('Back before the editor chunk lands still lists the created document', async () => {
  const router = renderApp()

  await screen.findByText('What will you make first?', undefined, { timeout: 15_000 })
  await userEvent.click(screen.getByRole('button', { name: /canvas/i }))

  // The create lands and the navigation starts; Back inside the mock's
  // delay window, BEFORE the editor module resolves.
  await waitFor(() => expect(router.state.location.pathname).toMatch(/\/d\//), {
    timeout: 15_000,
  })
  await router.navigate(-1)

  const titles = await screen.findAllByTestId('card-title', undefined, { timeout: 15_000 })
  expect(titles.length).toBeGreaterThan(0)
  expect(screen.queryByText('What will you make first?')).toBeNull()
})
