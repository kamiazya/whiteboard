/**
 * Arriving on a blank canvas: the canvas surface takes the keyboard, so the
 * first key after "Create a canvas" acts on the canvas rather than landing on
 * a heading that does nothing with it. Real routing, real IndexedDB and the
 * real editor, because the subject is where focus is when the editor arrives.
 */

import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { Loro } from 'loro-crdt'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { userEvent } from 'vitest/browser'
import { App } from '../App.js'
import { documentPath } from '../lib/app-routes.js'
import { LoroStore } from '../lib/loro-store.js'
import { BROWSER_DEFAULT_ADDRESS } from '../test-utils/browser-default-address.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedIdbDocument } from '../test-utils/seed-idb-document.js'

claimIsolatedWhiteboardDb('blank-canvas-arrival')

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

const surface = () => document.querySelector<HTMLElement>('[role="application"]')

describe('arriving on a blank canvas', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(cleanup)

  it('gives the canvas the keyboard, so N adds a note at once', async () => {
    renderApp()
    await screen.findByText('What will you make first?', undefined, SLOW)
    await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await waitFor(() => expect(document.activeElement).toBe(surface()), SLOW)

    await userEvent.keyboard('n')
    await waitFor(() => expect(surface()?.textContent).not.toContain('Double-click to add a note'))
  })

  it('leaves the keyboard where it was on a canvas that has content', async () => {
    const router = renderApp()
    await screen.findByText('What will you make first?', undefined, SLOW)
    const boardId = await seedIdbDocument({ path: 'board' })
    const doc = new Loro()
    writeSpatialCanvas(doc, {
      nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 200, height: 80, text: 'Held' })],
      edges: [],
    })
    await new LoroStore().save(boardId, doc.export({ mode: 'snapshot' }))
    const focused: Element[] = []
    const record = (event: FocusEvent) => {
      if (event.target instanceof Element) focused.push(event.target)
    }
    document.addEventListener('focusin', record)
    onTestFinished(() => document.removeEventListener('focusin', record))
    // As after opening a card: the control that opened it is gone, so the
    // arrival is the one deciding where the keyboard goes.
    ;(document.activeElement as HTMLElement | null)?.blur()
    await router.navigate(documentPath(BROWSER_DEFAULT_ADDRESS, 'board'))

    // Arrived: the tab is titled for the board, and its editor draws the note.
    await waitFor(() => expect(document.title).toBe('Untitled · Whiteboard'), SLOW)
    await waitFor(() => expect(surface()?.querySelector('[role="option"]')).not.toBeNull(), SLOW)
    expect(focused.some((element) => element.getAttribute('role') === 'application')).toBe(false)
  })
})
