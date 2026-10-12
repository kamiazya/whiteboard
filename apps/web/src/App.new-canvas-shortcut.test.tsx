/**
 * The installed app's "New canvas" launcher shortcut (`/?new=canvas`, declared
 * in `vite-pwa-options.ts`), driven through App's real routing.
 *
 * Through App rather than by mounting a page directly: what decides whether
 * the parameter is honoured is which page the router mounts for `/`, and what
 * the address sync does to the search on the way. A test that mounts the page
 * itself passes over both.
 *
 * Its own file because it needs a real registry and a real document list, and
 * `fake-indexeddb/auto` changes the environment for every test in a file (see
 * `App.workspace-switch.test.tsx`).
 */
import 'fake-indexeddb/auto'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import { getBrowserWorkspaceId } from './lib/browser-workspace-id.js'
import { sharedFoldingBrowserIndex } from './lib/folding-browser-index.js'
import type { ProviderState } from './lib/provider.js'
// The real list page, imported so its lazy() settles in a microtask: it is
// the page under test here.
import './pages/BrowserIndexPage.js'
import { clearWhiteboardDb, registerTestWorkspace } from './test-utils/browser-document.js'

// The editor is not what this file is about; that it MOUNTS is.
let openedPath: string | undefined
vi.mock('./pages/BrowserDocumentPage.js', () => ({
  BrowserDocumentPage: ({ initialPath }: { initialPath?: string }) => {
    openedPath = initialPath
    return <div data-testid="browser-document-page" />
  },
}))

const BROWSER_STATE: ProviderState = { kind: 'browser' }

beforeEach(async () => {
  openedPath = undefined
  await clearWhiteboardDb()
  await registerTestWorkspace()
})

afterEach(() => {
  cleanup()
})

async function documentCount(): Promise<number> {
  // The index the list page itself writes through: the workspace tree is
  // where a document lives, the plain IndexedDB rows are a cache of it.
  const index = sharedFoldingBrowserIndex()
  return (await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })).length
}

function renderAt(entry: string) {
  const router = createMemoryRouter(
    [{ path: '*', element: <App providerState={BROWSER_STATE} /> }],
    { initialEntries: [entry] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('the New canvas launcher shortcut', () => {
  it('creates one document, opens it, and leaves no parameter behind', async () => {
    const router = renderAt('/?new=canvas')
    await screen.findByTestId('browser-document-page', {}, { timeout: 10_000 })
    expect(await documentCount()).toBe(1)
    expect(openedPath).toBeDefined()
    expect(router.state.location.search).not.toContain('new=canvas')
    // No entry still carrying the parameter is left to come back to: a Back
    // into one would create a second document.
    await act(async () => {
      await router.navigate(-1)
    })
    expect(router.state.location.search).not.toContain('new=canvas')
    await waitFor(async () => expect(await documentCount()).toBe(1))
  })

  it('a plain load of the list creates nothing', async () => {
    renderAt('/')
    await screen.findByText('What will you make first?', {}, { timeout: 10_000 })
    expect(await documentCount()).toBe(0)
    expect(screen.queryByTestId('browser-document-page')).toBeNull()
  })

  it('a reload of where the shortcut landed does not create a second document', async () => {
    const first = renderAt('/?new=canvas')
    await screen.findByTestId('browser-document-page', {}, { timeout: 10_000 })
    const landed = first.state.location.pathname + first.state.location.search
    cleanup()

    renderAt(landed)
    await screen.findByTestId('browser-document-page', {}, { timeout: 10_000 })
    await waitFor(async () => expect(await documentCount()).toBe(1))
  })
})
