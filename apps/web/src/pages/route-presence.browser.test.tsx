/**
 * What a route change gives someone who cannot see it: the page's heading
 * takes focus, one polite region says where they are, the tab title follows,
 * and the page is one `<main>`. Real IndexedDB and routing; the canvas editor
 * is mocked because the subject is the route, not gesture input.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('route-presence')

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

const announcement = () => screen.getByRole('status', { name: 'Page' }).textContent

describe('route presence', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(cleanup)

  it('moves focus to the heading, announces and retitles on each route change', async () => {
    const router = renderApp()
    await screen.findByText('What will you make first?', undefined, SLOW)
    await waitFor(() => expect(announcement()).toBe('Documents'), SLOW)
    expect(document.title).toBe('Documents · Whiteboard')
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))

    await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await screen.findByTestId('mock-spatial-editor', undefined, SLOW)
    await waitFor(() => expect(announcement()).toBe('Untitled, canvas'), SLOW)
    expect(document.title).toBe('Untitled · Whiteboard')
    // The heading is the display name; the path is only its subtitle.
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('Untitled')
    expect(document.activeElement).toBe(heading)
    expect(screen.getAllByRole('main')).toHaveLength(1)

    await router.navigate(-1)
    await waitFor(() => expect(announcement()).toBe('Documents'), SLOW)
    await waitFor(
      () => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 })),
      SLOW,
    )
    expect(document.title).toBe('Documents · Whiteboard')
  })

  it('announces a fresh note and leaves focus to its editor', async () => {
    const router = renderApp()
    await screen.findByText('What will you make first?', undefined, SLOW)
    await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await screen.findByTestId('mock-spatial-editor', undefined, SLOW)
    await router.navigate(-1)
    await screen.findAllByTestId('card-title', undefined, SLOW)

    await userEvent.click(screen.getByRole('button', { name: 'New document' }))
    await userEvent.click(await screen.findByTestId('new-document-markdown'))
    // The second unnamed document: the list shows it as Untitled 2, so does the page.
    await waitFor(() => expect(announcement()).toBe('Untitled 2, markdown note'), SLOW)
    expect(document.title).toBe('Untitled 2 · Whiteboard')
    // The heading stood aside, so the editor's own autofocus still lands.
    await waitFor(
      () => expect(document.activeElement).toBe(document.querySelector('[contenteditable="true"]')),
      SLOW,
    )
  })

  it('puts focus on the heading of a note opened from the list', async () => {
    const router = renderApp()
    await screen.findByText('What will you make first?', undefined, SLOW)
    await userEvent.click(screen.getByRole('button', { name: 'Create a markdown note' }))
    const editor = () => document.querySelector<HTMLElement>('[contenteditable="true"]')
    await waitFor(() => expect(document.activeElement).toBe(editor()), SLOW)
    await userEvent.keyboard('Some text')
    await waitFor(() => expect(editor()?.textContent).toContain('Some text'), SLOW)
    await router.navigate(-1)
    const card = () => document.querySelector<HTMLElement>('main [data-doc-path]')
    await waitFor(() => expect(card()).not.toBeNull(), SLOW)
    card()?.focus()

    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(announcement()).toMatch(/markdown note$/), SLOW)
    await waitFor(
      () => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 })),
      SLOW,
    )
  })

  it('names an unnamed document the way the list does', async () => {
    const router = renderApp()
    await screen.findByText('What will you make first?', undefined, SLOW)
    await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await screen.findByTestId('mock-spatial-editor', undefined, SLOW)
    await router.navigate(-1)
    await screen.findAllByTestId('card-title', undefined, SLOW)
    await userEvent.click(screen.getByRole('button', { name: 'New document' }))
    await userEvent.click(await screen.findByTestId('new-document-spatial'))

    await waitFor(() => expect(announcement()).toBe('Untitled 2, canvas'), SLOW)
    expect(document.title).toBe('Untitled 2 · Whiteboard')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Untitled 2')
    await waitFor(
      () =>
        expect(screen.getByRole('textbox', { name: /title/i }).getAttribute('placeholder')).toBe(
          'Untitled 2',
        ),
      SLOW,
    )
  })

  it('gives focus back to the card of the document Back came from', async () => {
    const router = renderApp()
    await screen.findByText('What will you make first?', undefined, SLOW)
    await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await screen.findByTestId('mock-spatial-editor', undefined, SLOW)
    await router.navigate(-1)
    const card = () => document.querySelector<HTMLElement>('main [data-doc-path]')
    await waitFor(() => expect(card()).not.toBeNull(), SLOW)

    await userEvent.dblClick(card() as HTMLElement)
    await screen.findByTestId('mock-spatial-editor', undefined, SLOW)
    await router.navigate(-1)
    await waitFor(() => expect(document.activeElement).toBe(card()), SLOW)
  })

  it('offers Skip to content as the first Tab stop of the page', async () => {
    renderApp()
    await screen.findByText('What will you make first?', undefined, SLOW)
    // First in document order is first in Tab order: nothing here sets a
    // positive tabindex.
    const first = document.querySelector<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    expect(first?.textContent).toBe('Skip to content')
    first?.focus()
    await userEvent.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByRole('main'))
  })
})
