/**
 * Back from a document gives focus to the row it was opened from, whichever
 * surface of the list that was: a grid card, a folder-tree row or a search
 * result. Real IndexedDB and routing; the canvas editor is mocked because
 * the subject is the return, not gesture input.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { STORAGE_KEY as RECENT_KEY } from '../lib/recent-documents.js'
import { forgetSearchQueries } from '../lib/search-query-memory.js'
import { STORAGE_KEY as SEEN_KEY } from '../lib/seen-documents.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('back-focus-surfaces')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
}))

const { App } = await import('../App.js')

const SLOW = { timeout: 15_000 }

function renderApp() {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: ['/'] })
  rtlRender(
    <div style={{ height: '100vh' }}>
      <RouterProvider router={router} />
    </div>,
  )
  return router
}

/** A workspace holding one canvas, with the list on screen again. */
async function listWithOneCanvas() {
  const router = renderApp()
  await screen.findByText('What will you make first?', undefined, SLOW)
  await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
  await screen.findByTestId('mock-spatial-editor', undefined, SLOW)
  await router.navigate(-1)
  await waitFor(() => expect(document.querySelector('main [data-doc-path]')).not.toBeNull(), SLOW)
  return router
}

describe('Back focus', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(() => {
    cleanup()
    // The list remembers its query for the tab, so a repeat would type into
    // the last run's search.
    forgetSearchQueries()
    // Every open also lands in the Recent lane and changed-dot baseline,
    // which live in localStorage.
    localStorage.removeItem(RECENT_KEY)
    localStorage.removeItem(SEEN_KEY)
  })

  it('returns to the folder-tree row the document was opened from', async () => {
    const router = await listWithOneCanvas()
    // The choice is remembered in localStorage, which the next file in the
    // same browser reads: a list left in one column has no Recent lane.
    onTestFinished(() => localStorage.removeItem('whiteboard.document-browser.columns.v1'))
    await userEvent.click(screen.getByRole('button', { name: 'One column' }))
    const row = () => document.querySelector<HTMLElement>('main [role="tree"] [data-doc-path]')
    await waitFor(() => expect(row()).not.toBeNull(), SLOW)
    row()?.focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByTestId('mock-spatial-editor', undefined, SLOW)
    await router.navigate(-1)
    await waitFor(() => expect(document.activeElement).toBe(row()), SLOW)
  })

  it('returns to the search result the document was opened from', async () => {
    const router = await listWithOneCanvas()
    await userEvent.click(screen.getByLabelText('Search documents'))
    await userEvent.keyboard('Untitled')
    const result = () =>
      document.querySelector<HTMLElement>('[aria-label="Search results"] [data-doc-path]')
    await waitFor(() => expect(result()).not.toBeNull(), SLOW)
    result()?.focus()
    await userEvent.keyboard('{Enter}')
    await screen.findByTestId('mock-spatial-editor', undefined, SLOW)
    await router.navigate(-1)
    await waitFor(() => expect(document.activeElement).toBe(result()), SLOW)
  })
})
