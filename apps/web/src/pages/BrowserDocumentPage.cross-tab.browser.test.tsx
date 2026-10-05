/**
 * Two pages open on one browser-kept note, standing for two tabs: each mounts
 * its own backend, and BroadcastChannel delivers between channel objects in
 * one realm exactly as it does between tabs.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { FoldingBrowserIndex } from '../lib/folding-browser-index.js'
import { IdbDocumentIndex } from '../lib/idb-document-index.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { focusEditable } from '../test-utils/focus-editable.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'
import '../index.css'
import { renderInRouter } from '../test-utils/daemon-page-harness.js'

claimIsolatedWhiteboardDb('browserdocumentpage-cross-tab')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
}))

const { BrowserDocumentPage } = await import('./BrowserDocumentPage.js')
const { App } = await import('../App.js')

const render = (ui: ReactElement) => renderInRouter(ui, { height: '50vh' })

/** The source editor inside the page mounted in `container`. */
function editorIn(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.cm-content[contenteditable="true"]')
}

beforeEach(async () => {
  await clearWhiteboardDb()
})
afterEach(async () => {
  cleanup()
  await clearWhiteboardDb()
})

it('a line typed on one page shows up on the other page open on the note', async () => {
  const store = new FoldingBrowserIndex()
  await seedIdbDocument(new IdbDocumentIndex(), {
    path: 'note',
    kind: 'markdown',
    makeDefault: true,
  })
  const tabA = render(<BrowserDocumentPage store={store} />)
  const tabB = render(<BrowserDocumentPage store={store} />)
  await waitFor(() => expect(editorIn(tabB.container)).not.toBeNull(), { timeout: 10_000 })

  await focusEditable(() => editorIn(tabA.container))
  await userEvent.keyboard('# From tab A')

  await waitFor(() => expect(editorIn(tabB.container)?.textContent).toBe('# From tab A'), {
    timeout: 10_000,
  })
})

it('a page opened later on the note is heard by the page that was there first', async () => {
  const store = new FoldingBrowserIndex()
  await seedIdbDocument(new IdbDocumentIndex(), {
    path: 'note',
    kind: 'markdown',
    makeDefault: true,
  })
  const tabA = render(<BrowserDocumentPage store={store} />)
  await focusEditable(() => editorIn(tabA.container))
  await userEvent.keyboard('# From tab A')
  await waitFor(
    () =>
      expect(
        tabA.container
          .querySelector('[data-testid="persistence-state"]')
          ?.getAttribute('data-save-state'),
      ).toBe('saved'),
    { timeout: 10_000 },
  )

  const tabB = render(<BrowserDocumentPage store={store} />)
  await waitFor(() => expect(editorIn(tabB.container)?.textContent).toBe('# From tab A'), {
    timeout: 10_000,
  })
  await focusEditable(() => editorIn(tabB.container))
  await userEvent.keyboard('{Control>}{End}{/Control}{Enter}From tab B')

  await waitFor(
    () => expect(editorIn(tabA.container)?.textContent).toBe('# From tab AFrom tab B'),
    { timeout: 10_000 },
  )
})

it('a note created from the list hears a page opened on it afterwards', async () => {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: ['/'] })
  const tabA = rtlRender(
    <div style={{ height: '50vh' }}>
      <RouterProvider router={router} />
    </div>,
  )
  await screen.findByText('What will you make first?', undefined, { timeout: 15_000 })
  screen.getByRole('button', { name: 'Create a markdown note' }).click()
  await focusEditable(() => editorIn(tabA.container))
  await userEvent.keyboard('# From tab A')
  await waitFor(
    () =>
      expect(
        tabA.container
          .querySelector('[data-testid="persistence-state"]')
          ?.getAttribute('data-save-state'),
      ).toBe('saved'),
    { timeout: 10_000 },
  )

  const path = decodeURIComponent(router.state.location.pathname.split('/d/')[1] ?? '')
  const tabB = render(<BrowserDocumentPage initialPath={path} />)
  await waitFor(() => expect(editorIn(tabB.container)?.textContent).toBe('# From tab A'), {
    timeout: 10_000,
  })
  await focusEditable(() => editorIn(tabB.container))
  await userEvent.keyboard('{Control>}{End}{/Control}{Enter}From tab B')

  await waitFor(
    () => expect(editorIn(tabA.container)?.textContent).toBe('# From tab AFrom tab B'),
    { timeout: 10_000 },
  )
})
