/**
 * Browser-local list landing flow (real IndexedDB + real routing): '/'
 * lands on the canvas list, the empty state and the + menu create real
 * canvases through the same store the editor uses, and browser Back
 * crosses the editor/list boundary with the list reflecting what was just
 * created. SpatialEditor is mocked (the subject is routing + list wiring,
 * not gesture input); the markdown editor and IndexedDB are real.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { clearWhiteboardDb } from '../test-utils/browser-local-canvas.js'
import '../index.css'

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
}))

const { App } = await import('../App.js')

function renderApp() {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], {
    initialEntries: ['/'],
  })
  rtlRender(
    // Pages fill their allotted height (h-full) — the app shell owns the
    // viewport in production, so tests supply the equivalent sized parent.
    <div style={{ height: '100vh' }}>
      <RouterProvider router={router} />
    </div>,
  )
  return router
}

describe('browser-local list landing (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it("'/' lands on the list; create, edit, Back, and the list shows the work", async () => {
    const router = renderApp()

    // Fresh store: the list's empty state, not an auto-opened editor.
    await screen.findByText('No canvases yet', undefined, { timeout: 15_000 })

    // Empty-state create opens a spatial canvas at /local/:id.
    await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
    expect(router.state.location.pathname).toMatch(/^\/local\//)

    // Back: the boundary crossing returns to the list, which now has the row.
    await router.navigate(-1)
    const firstCards = await screen.findAllByTestId('canvas-list-card', undefined, {
      timeout: 15_000,
    })
    expect(firstCards).toHaveLength(1)

    // The + menu creates a markdown note and opens the real editor.
    await userEvent.click(screen.getByRole('button', { name: 'New canvas' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'New markdown note' }))
    const editable = await waitFor(
      () => {
        const el = document.querySelector('[contenteditable="true"]')
        expect(el).not.toBeNull()
        return el as HTMLElement
      },
      { timeout: 15_000 },
    )
    await waitFor(() => {
      expect(editable.closest('.cm-editor')?.contains(document.activeElement)).toBe(true)
    })
    await userEvent.keyboard('# From the list')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe('# From the list')
    })
    // The page's own report that the debounced write reached IndexedDB —
    // waiting on it keeps this off the timing-flake shape.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy(), {
      timeout: 15_000,
    })

    // Back again: both canvases listed, the note marked as markdown.
    await router.navigate(-1)
    const cards = await screen.findAllByTestId('canvas-list-card', undefined, { timeout: 15_000 })
    expect(cards).toHaveLength(2)
    const markdownCard = cards.find((c) => within(c).queryByText(/markdown/i))
    expect(markdownCard).toBeDefined()

    // Reopening the note restores the typed body from the same store.
    await userEvent.click(markdownCard!)
    await waitFor(
      () => {
        expect(document.querySelector('.cm-content')?.textContent).toContain('# From the list')
      },
      { timeout: 15_000 },
    )
  })
})
