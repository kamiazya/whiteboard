/**
 * The installed app's "New canvas" launcher shortcut, driven through App's
 * real routing from the URL the manifest itself declares — so a manifest and
 * a page that disagree on the parameter fail here, rather than each side's
 * test passing on its own copy.
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
import { pwaOptions } from '../vite-pwa-options.js'
import { App } from './App.js'
import { getBrowserWorkspaceId } from './lib/browser-workspace-id.js'
import { sharedFoldingBrowserIndex } from './lib/folding-browser-index.js'
import type { ProviderState } from './lib/provider.js'
import { resetShellStatusForTests, setShellConnection } from './lib/shell-status-store.js'
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
  Reflect.deleteProperty(window, 'launchQueue')
  resetShellStatusForTests()
})

async function documentCount(): Promise<number> {
  // The index the list page itself writes through: the workspace tree is
  // where a document lives, the plain IndexedDB rows are a cache of it.
  const index = sharedFoldingBrowserIndex()
  return (await index.listDocuments({ workspaceId: getBrowserWorkspaceId() })).length
}

function manifestShortcutUrl(): string {
  const manifest = pwaOptions.manifest
  if (!manifest) throw new Error('the PWA options declare no manifest')
  const url = manifest.shortcuts?.find((s) => s.name === 'New canvas')?.url
  if (url === undefined) throw new Error('the manifest declares no "New canvas" shortcut')
  return url
}

/** Whether the address still carries any parameter the shortcut put there. */
function carriesShortcutParam(search: string): boolean {
  const shortcut = new URL(manifestShortcutUrl(), 'https://app.invalid').searchParams
  const now = new URLSearchParams(search)
  return [...shortcut.keys()].some((key) => now.has(key))
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
    const router = renderAt(manifestShortcutUrl())
    await screen.findByTestId('browser-document-page', {}, { timeout: 10_000 })
    expect(await documentCount()).toBe(1)
    expect(openedPath).toBeDefined()
    expect(carriesShortcutParam(router.state.location.search)).toBe(false)
    // No entry still carrying the parameter is left to come back to: a Back
    // into one would create a second document.
    await act(async () => {
      await router.navigate(-1)
    })
    expect(carriesShortcutParam(router.state.location.search)).toBe(false)
    await waitFor(async () => expect(await documentCount()).toBe(1))
  })

  it('a plain load of the list creates nothing', async () => {
    renderAt('/')
    await screen.findByText('What will you make first?', {}, { timeout: 10_000 })
    expect(await documentCount()).toBe(0)
    expect(screen.queryByTestId('browser-document-page')).toBeNull()
  })

  it('a reload of where the shortcut landed does not create a second document', async () => {
    const first = renderAt(manifestShortcutUrl())
    await screen.findByTestId('browser-document-page', {}, { timeout: 10_000 })
    const landed = first.state.location.pathname + first.state.location.search
    cleanup()

    renderAt(landed)
    await screen.findByTestId('browser-document-page', {}, { timeout: 10_000 })
    await waitFor(async () => expect(await documentCount()).toBe(1))
  })
})

// With the installed app already open, `launch_handler: focus-existing` only
// focuses the window: the shortcut's URL arrives as LaunchParams on
// `window.launchQueue` (WICG Web App Launch Handler), never as a navigation.
describe('the New canvas launcher shortcut while the app is already open', () => {
  type Consumer = (params: { targetURL?: string | null }) => void
  function stubLaunchQueue(): { launch: (url: string) => void } {
    let consumer: Consumer | undefined
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      value: { setConsumer: (next: Consumer) => (consumer = next) },
    })
    return {
      launch(url) {
        if (consumer === undefined) throw new Error('nothing consumes window.launchQueue')
        const targetURL = new URL(url, window.location.origin).href
        act(() => consumer?.({ targetURL }))
      },
    }
  }

  it('creates and opens a document from the list', async () => {
    const queue = stubLaunchQueue()
    const router = renderAt('/')
    await screen.findByText('What will you make first?', {}, { timeout: 10_000 })

    queue.launch(manifestShortcutUrl())

    await screen.findByTestId('browser-document-page', {}, { timeout: 10_000 })
    expect(await documentCount()).toBe(1)
    expect(carriesShortcutParam(router.state.location.search)).toBe(false)
  })

  it('creates and opens a second document from an open one', async () => {
    const queue = stubLaunchQueue()
    renderAt(manifestShortcutUrl())
    await screen.findByTestId('browser-document-page', {}, { timeout: 10_000 })
    const first = openedPath

    queue.launch(manifestShortcutUrl())

    await waitFor(async () => expect(await documentCount()).toBe(2), { timeout: 10_000 })
    await waitFor(() => expect(openedPath).not.toBe(first))
    expect(screen.getByTestId('browser-document-page')).toBeDefined()
  })

  it('a plain launch only focuses: it creates nothing and stays put', async () => {
    const queue = stubLaunchQueue()
    const router = renderAt('/')
    await screen.findByText('What will you make first?', {}, { timeout: 10_000 })
    const before = router.state.location

    queue.launch('/')

    expect(router.state.location).toBe(before)
    expect(await documentCount()).toBe(0)
  })

  it('a tab holding a write that did not land stays where it is', async () => {
    const queue = stubLaunchQueue()
    const router = renderAt('/')
    await screen.findByText('What will you make first?', {}, { timeout: 10_000 })
    setShellConnection({ state: { keeper: 'browser', storage: 'failed' } })
    const before = router.state.location

    queue.launch(manifestShortcutUrl())

    expect(router.state.location).toBe(before)
    expect(await documentCount()).toBe(0)
  })
})
