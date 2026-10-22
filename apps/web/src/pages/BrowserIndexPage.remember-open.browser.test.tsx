/**
 * A document opened by address (not by a card click) still enters Recent and
 * takes the listing's digest as its seen baseline, against real IndexedDB:
 * going back to the list shows no "changed" dot on it.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { browserMemoryScope } from '../components/workspace-files/use-device-memory.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { STORAGE_KEY as RECENT_KEY, readRecentIds } from '../lib/recent-documents.js'
import { readSeenDigest, STORAGE_KEY as SEEN_KEY } from '../lib/seen-documents.js'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import '../index.css'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'

claimIsolatedWhiteboardDb('browserindexpage-remember-open')

vi.mock('../components/spatial-editor/index.js', () => ({
  SpatialEditor: (_props: { canvas: SpatialCanvas }) => <div data-testid="mock-spatial-editor" />,
}))

const { App } = await import('../App.js')

describe('a document opened by address is remembered (browser — real IndexedDB)', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })
  afterEach(cleanup)

  it('enters Recent with a seen baseline and shows no changed dot', async () => {
    const router = createMemoryRouter([{ path: '*', element: <App /> }], {
      initialEntries: ['/'],
    })
    rtlRender(
      <div style={{ height: '100vh' }}>
        <RouterProvider router={router} />
      </div>,
    )
    await screen.findByText('What will you make first?', undefined, { timeout: 15_000 })
    await userEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })
    const documentAddress = router.state.location.pathname

    // Forget what Create recorded, so only the address-open can restore it.
    localStorage.removeItem(RECENT_KEY)
    localStorage.removeItem(SEEN_KEY)
    await router.navigate(-1)
    await screen.findAllByTestId('card-title', undefined, { timeout: 15_000 })
    await router.navigate(documentAddress)
    await screen.findByTestId('mock-spatial-editor', undefined, { timeout: 15_000 })

    const scope = browserMemoryScope({ workspaceId: getBrowserWorkspaceId() })
    await waitFor(() => expect(readRecentIds(scope)).toHaveLength(1), { timeout: 15_000 })
    const [id] = readRecentIds(scope)
    await waitFor(() => expect(readSeenDigest(scope, id!)).toBeDefined(), { timeout: 15_000 })

    await router.navigate(-1)
    await screen.findAllByTestId('card-title', undefined, { timeout: 15_000 })
    expect(screen.queryByTestId('card-changed-dot')).toBeNull()
  })
})
