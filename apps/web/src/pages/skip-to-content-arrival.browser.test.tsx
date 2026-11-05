/**
 * Skip to content stays the first Tab stop on a fresh load even though the
 * list's heading takes focus on arrival: the heading sits after the shell's
 * header, so an unaided Tab from it would pass the skip link by. Real
 * IndexedDB and routing, as in route-presence.browser.test.tsx.
 */

import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { App } from '../App.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('skip-to-content-arrival')

const SLOW = { timeout: 15_000 }

beforeEach(async () => {
  await clearWhiteboardDb()
})
afterEach(cleanup)

it('takes the first Tab after Home focuses its heading', async () => {
  const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: ['/'] })
  rtlRender(
    <div style={{ height: '100vh' }}>
      <RouterProvider router={router} />
    </div>,
  )
  await screen.findByText('What will you make first?', undefined, SLOW)
  const heading = screen.getByRole('heading', { level: 1 })
  await waitFor(() => expect(document.activeElement).toBe(heading), SLOW)
  await userEvent.keyboard('{Tab}')
  expect(document.activeElement?.textContent).toBe('Skip to content')
  await userEvent.keyboard('{Enter}')
  expect(document.activeElement).toBe(screen.getByRole('main'))
  // Only the first: from the content, Tab moves on into the page.
  await userEvent.keyboard('{Tab}')
  expect(document.activeElement?.textContent).not.toBe('Skip to content')
  expect(screen.getByRole('main').contains(document.activeElement)).toBe(true)
})
