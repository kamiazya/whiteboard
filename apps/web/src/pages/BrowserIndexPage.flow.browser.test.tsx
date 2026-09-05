/**
 * Browser-kept landing flow (real IndexedDB + real routing): '/' lands on
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
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { waitForMarkdownSaved } from '../test-utils/wait-for-saved.js'

claimIsolatedWhiteboardDb('browserindexpage-flow')

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

describe('browser list landing (browser — real IndexedDB)', () => {
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

    // Empty-state create opens a spatial canvas at /w/:workspace/d/:id.
    await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
    expect(router.state.location.pathname).toMatch(/^\/w\/default\/d\//)

    // Back: the boundary crossing returns to the browser, which now has the
    // row in its folder pane.
    await router.navigate(-1)
    const firstCards = await screen.findAllByTestId('card-title', undefined, {
      timeout: 15_000,
    })
    expect(firstCards).toHaveLength(1)

    // The panel's create OPENS what it made, like every other creation path
    // in the app — an empty document is worth nothing until it is open, and
    // the folder you were standing in is in the address, so Back returns to
    // it rather than to the workspace root.
    await userEvent.click(screen.getByRole('button', { name: 'New document' }))
    await userEvent.click(await screen.findByTestId('new-document-markdown'))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/w\/default\/d\//), {
      timeout: 15_000,
    })
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
    // Anchored on the last keystroke, not on a settle window: the binding
    // commits into the doc synchronously with each key, so any write that
    // COMPLETES after this instant contains all of them. Unanchored, this
    // wait settled on a mid-typing write under CI load and the navigation
    // below dropped the rest — `expected '# From t' to contain
    // '# From the list'`.
    const typedAt = Date.now()
    // The only wait in this file that was left on testing-library's 1000ms
    // default, and the one that failed on CI: `Expected: "# From the list" /
    // Received: "# F"`. `userEvent.keyboard` awaits each key's DISPATCH,
    // while CodeMirror renders the resulting text afterwards, so under a
    // loaded runner three characters had landed when the budget expired. The
    // assertion is unchanged — every keystroke still has to arrive; only the
    // budget matches the ten waits around it.
    await waitFor(
      () => {
        expect(document.querySelector('.cm-content')?.textContent).toBe('# From the list')
      },
      { timeout: 15_000 },
    )
    await waitForMarkdownSaved({ since: typedAt })

    // Back again: both documents listed, the note marked as markdown.
    await router.navigate(-1)
    const cards = await screen.findAllByTestId('card-title', undefined, { timeout: 15_000 })
    expect(cards).toHaveLength(2)
    const backBadges = screen.getAllByTestId('card-kind-badge')
    const noteIndex = backBadges.findIndex((el) => el.getAttribute('data-kind') === 'markdown')
    expect(noteIndex).toBeGreaterThanOrEqual(0)

    // Reopening the note restores the typed body from the same store.
    // The ROW, not its title span: a title span is located by its text, and
    // the row's decorative SVG miniature renders the same words once the note
    // carries a real name — two matches, and a strict-mode violation that
    // reads like the card is missing.
    await userEvent.click(screen.getAllByTestId('card-title')[noteIndex]!.closest('button')!)
    await userEvent.click(await screen.findByRole('button', { name: 'Open' }))
    await waitFor(
      () => {
        expect(document.querySelector('.cm-content')?.textContent).toContain('# From the list')
      },
      { timeout: 15_000 },
    )

    // Back to the browser, then delete both documents through the preview
    // pane's Delete and the real AlertDialog. Deleting the LAST document must
    // NOT swap to onboarding: the deletes just filled the trash, and the
    // Trash section is the one affordance that undoes them.
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
    const trash = await screen.findByTestId('trash-section', undefined, { timeout: 15_000 })
    expect(screen.queryByText('What will you make first?')).toBeNull()

    // Restore one from the trash: the card returns to the list.
    // The count is a SECOND async list, and the loop above only waited for the
    // card list to shrink — so the section can still read `Trash (1)` here while
    // the delete's own trash re-read is in flight.
    await userEvent.click(await within(trash).findByText(/^Trash \(2\)/))
    await userEvent.click((await within(trash).findAllByRole('button', { name: 'Restore' }))[0]!)
    await waitFor(() => expect(screen.queryAllByTestId('card-title')).toHaveLength(1), {
      timeout: 15_000,
    })
  })
})
