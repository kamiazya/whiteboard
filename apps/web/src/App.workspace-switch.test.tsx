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

  it('a rename that moves the address takes the address and the runtime with it', async () => {
    // The rename goes through the same library function the shell's switcher
    // calls, then the address moves the way its `onSwitch` moves it. What
    // this pins is the half after that: `/w/renamed` has to RESOLVE, against
    // a registry row whose segment was `default` when this page loaded.
    // Renaming only the display name instead leaves the address unresolvable
    // and the rewrite guard sends the page back to `/w/default` — which is
    // what the assertion below would report.
    const { renameBrowserWorkspace } = await import('./lib/browser-workspaces.js')
    const router = createMemoryRouter(
      [{ path: '*', element: <App providerState={BROWSER_STATE} /> }],
      { initialEntries: ['/w/default'] },
    )
    render(<RouterProvider router={router} />)
    await screen.findByTestId('browser-index-page')

    const renamed = await renameBrowserWorkspace(settled, {
      segment: 'renamed',
      displayName: 'Renamed',
    })
    expect(renamed.segment).toBe('renamed')
    await act(async () => {
      await router.navigate('/w/renamed')
    })

    await waitFor(() => expect(getBrowserWorkspaceId()).toBe(settled))
    // Kept, not rewritten: a rewrite here would mean the new address failed
    // to resolve, which is the same failure as a rename nobody stored.
    expect(router.state.location.pathname).toBe('/w/renamed')
  })

  it('rewrites an address the registry cannot resolve, and stays where it was', async () => {
    // The active identity, set HERE rather than left to `afterEach`, because
    // `afterEach` is not the last write and cannot be. `switchBrowserWorkspace`
    // stores the identity in module state through an IndexedDB read that
    // nothing cancels when the component that started it unmounts — so a read
    // still in flight from the rename above lands in whichever test is
    // running when it finishes, overwriting the reset that already ran.
    //
    // What that costs is this assertion, and it says nothing about a switch:
    // the rewrite goes to the active workspace's handle, so a leaked
    // `renamed` makes the address below `/w/renamed` and reads as a rewrite
    // that went somewhere nobody asked for. Measured — standing in for one
    // such late write reproduces it exactly, and it is what failed on CI
    // while passing five runs out of five locally.
    setBrowserWorkspaceIdForTests(settled, 'default')

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
