/**
 * The browser keeper's workspace switch, as ADR-0019 decided it: an in-SPA
 * route change, not a document load.
 *
 * Its own file because it needs a real registry to switch INTO, and
 * `fake-indexeddb/auto` changes the environment for every test in a file —
 * `App.test.tsx` has 65 cases written without one, several of which exercise
 * paths where the IndexedDB open fails. Importing it there would quietly move
 * them onto a different branch.
 */
import 'fake-indexeddb/auto'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import { getBrowserWorkspaceId, setBrowserWorkspaceIdForTests } from './lib/browser-workspace-id.js'
import { IdbDocumentIndex } from './lib/idb-document-index.js'
import type { ProviderState } from './lib/provider.js'

// Mocked for the same reason App.test.tsx mocks them: this file is about
// App's routing and the runtime it points at, not about what a page renders.
vi.mock('./pages/BrowserIndexPage.js', () => ({
  BrowserIndexPage: () => <div data-testid="browser-index-page" />,
}))
vi.mock('./pages/BrowserDocumentPage.js', () => ({
  BrowserDocumentPage: () => <div data-testid="browser-document-page" />,
}))
vi.mock('./hooks/useDaemonConnection.js', () => ({
  useDaemonConnection: () => ({ status: 'none' }),
}))

const BROWSER_STATE: ProviderState = {
  kind: 'browser',
  capabilities: { versions: false, branches: false, merge: false },
}

// Fixed rather than minted: two ULIDs made inside one millisecond order
// randomly, and an assertion on identity must not rest on a coincidence.
const SECOND_ULID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

let settled = ''

beforeEach(async () => {
  settled = getBrowserWorkspaceId()
  await new IdbDocumentIndex().createWorkspace({ workspaceId: settled, segment: 'default' })
})

afterEach(() => {
  cleanup()
  setBrowserWorkspaceIdForTests(settled, 'default')
})

describe('browser workspace switch', () => {
  it('is an in-SPA route change: the address moves and the runtime follows it', async () => {
    // ADR-0004's "decided once at page load" governs KEEPER swaps, not
    // movement between two workspaces of the same keeper — so this is a route
    // change, and the active workspace follows the address rather than the
    // page being thrown away and rebuilt. Driven through the address because
    // that is the switcher's whole output.
    await new IdbDocumentIndex().createWorkspace({
      workspaceId: SECOND_ULID,
      segment: 'second',
    })
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={BROWSER_STATE} /> }],
      { initialEntries: ['/w/default'] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId('browser-index-page')

    await act(async () => {
      await router.navigate('/w/second')
    })

    await waitFor(() => expect(getBrowserWorkspaceId()).toBe(SECOND_ULID))
    // The address KEPT. The rewrite guard has to read this as a switch, not
    // as an address naming a workspace this browser does not hold.
    expect(router.state.location.pathname).toBe('/w/second')
  })

  it('rewrites an address the registry cannot resolve, and stays where it was', async () => {
    // The other half, and why the switch resolve is STRICT while the boot one
    // is lenient. A lenient switch would answer any unknown handle with
    // first-listed; this effect would then leave the address alone believing
    // it had switched, and the address would name a workspace nobody has.
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={BROWSER_STATE} /> }],
      { initialEntries: ['/w/no-such-workspace'] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId('browser-index-page')

    await waitFor(() => expect(router.state.location.pathname).toBe('/w/default'))
    expect(getBrowserWorkspaceId()).toBe(settled)
  })
})
