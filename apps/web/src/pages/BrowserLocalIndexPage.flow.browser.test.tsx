/**
 * Browser-local landing flow (real IndexedDB + real routing): '/' lands on
 * the document browser, the onboarding empty state and the panel's create
 * buttons make real documents through the same store the editor uses, and
 * browser Back crosses the editor/list boundary with the panel reflecting
 * what was just created. SpatialEditor is mocked (the subject is routing +
 * wiring, not gesture input); the markdown editor and IndexedDB are real.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { clearWhiteboardDb } from '../test-utils/browser-local-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserlocalindexpage-flow')

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
    // Only the keys this page reads — storages are origin-shared across
    // parallel test files.
    localStorage.removeItem('whiteboard.markdown-view-mode')
    sessionStorage.removeItem('wb.lastTool')
  })

  afterEach(() => {
    cleanup()
  })

  it("'/' lands on the list; create, edit, Back, and the list shows the work", async () => {
    const router = renderApp()

    // Fresh store: the list's empty state, not an auto-opened editor.
    await screen.findByText('What will you make first?', undefined, { timeout: 15_000 })

    // Empty-state create opens a spatial canvas at /local/:id.
    await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
    expect(router.state.location.pathname).toMatch(/^\/local\//)

    // Back: the boundary crossing returns to the browser, which now has the
    // row in its folder pane.
    await router.navigate(-1)
    const firstCards = await screen.findAllByTestId('card-title', undefined, {
      timeout: 15_000,
    })
    expect(firstCards).toHaveLength(1)

    // The panel creates a markdown note in place; opening it is a second,
    // explicit step through the preview pane.
    await userEvent.click(screen.getByRole('button', { name: 'New markdown document' }))
    const noteTitle = await waitFor(
      () => {
        const titles = screen.getAllByTestId('card-title')
        expect(titles).toHaveLength(2)
        return titles
      },
      { timeout: 15_000 },
    )
    expect(noteTitle).toHaveLength(2)
    // Select the markdown row (the one whose subtitle says markdown) and open it.
    const subtitles = screen.getAllByTestId('card-subtitle')
    const mdIndex = subtitles.findIndex((el) => el.textContent?.includes('markdown'))
    expect(mdIndex).toBeGreaterThanOrEqual(0)
    await userEvent.click(screen.getAllByTestId('card-title')[mdIndex]!)
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }))
    const editable = await waitFor(
      () => {
        const el = document.querySelector('[contenteditable="true"]')
        expect(el).not.toBeNull()
        return el as HTMLElement
      },
      { timeout: 15_000 },
    )
    // An opened note is focused for typing immediately (no click). Exact
    // contentDOM identity — not .cm-editor containment — is what real
    // keyboard-event delivery depends on; containment can pass while focus
    // still sits on another in-flight descendant and race the first keys.
    // 10s, like the neighbouring waits: this one covers navigation, mount and
    // autofocus against a real browser, and testing-library's 1s default
    // expires under CI load with focus still on <body>.
    await waitFor(
      () => {
        expect(document.activeElement).toBe(editable)
      },
      { timeout: 10_000 },
    )
    await userEvent.keyboard('# From the list')
    await waitFor(() => {
      expect(document.querySelector('.cm-content')?.textContent).toBe('# From the list')
    })
    // The page's own report that the debounced write reached IndexedDB —
    // waiting on it keeps this off the timing-flake shape.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy(), {
      timeout: 15_000,
    })

    // Back again: both documents listed, the note marked as markdown.
    await router.navigate(-1)
    const cards = await screen.findAllByTestId('card-title', undefined, { timeout: 15_000 })
    expect(cards).toHaveLength(2)
    const backSubtitles = screen.getAllByTestId('card-subtitle')
    const noteIndex = backSubtitles.findIndex((el) => el.textContent?.includes('markdown'))
    expect(noteIndex).toBeGreaterThanOrEqual(0)

    // Reopening the note restores the typed body from the same store.
    await userEvent.click(screen.getAllByTestId('card-title')[noteIndex]!)
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await waitFor(
      () => {
        expect(document.querySelector('.cm-content')?.textContent).toContain('# From the list')
      },
      { timeout: 15_000 },
    )

    // Back to the browser, then delete both documents through the preview
    // pane's Delete and the real AlertDialog: the onboarding state returns.
    await router.navigate(-1)
    await screen.findAllByTestId('card-title', undefined, { timeout: 15_000 })
    for (let remaining = 2; remaining > 0; remaining--) {
      await userEvent.click(screen.getAllByTestId('card-title')[0]!)
      await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
      const dialog = await screen.findByRole('alertdialog')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull(), {
        timeout: 15_000,
      })
      await waitFor(
        () => expect(screen.queryAllByTestId('card-title')).toHaveLength(remaining - 1),
        {
          timeout: 15_000,
        },
      )
    }
    await screen.findByText('What will you make first?', undefined, { timeout: 15_000 })
  })
})
