/**
 * An ADDRESS naming a daemon workspace wins over whichever workspace the
 * daemon happens to list first.
 *
 * Its own file because it needs the REAL `DaemonIndexPage` — `App.test.tsx`
 * mocks it, and the defect this covers lives in the conversation between the
 * page's selection settling and App's address rewriter, which a stub cannot
 * have. The two disagreed once, and the shape is worth stating: the page
 * resolved the first-listed workspace, App wrote that back to the address,
 * the page re-resolved, and the address went round several hundred times in
 * eight seconds while the document never opened. Observed against a dev
 * daemon holding two workspaces, one of them with no segment, and bisected to
 * a commit that touched neither.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from './App.js'
import type { ProviderState } from './lib/provider.js'
// Statically imported so `lazy()` settles in a microtask rather than racing a
// `findBy*`'s 1000ms budget — the rule `App.lazy-coverage.test.ts` enforces
// for `App.test.tsx`. This is the page under test, so it is imported rather
// than mocked; every other lazy page is mocked below.
import './pages/DaemonIndexPage.js'

vi.mock('./hooks/useDaemonConnection.js', () => ({
  useDaemonConnection: () => ({ status: 'none' }),
}))

vi.mock('./components/status/NotFoundPage.js', () => ({
  NotFoundPage: () => <div data-testid="not-found-page" />,
}))
vi.mock('./pages/PairConsentPage.js', () => ({
  PairConsentPage: () => <div data-testid="pair-consent-page" />,
}))
vi.mock('./pages/SettingsPage.js', () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}))
vi.mock('./pages/BrowserDocumentPage.js', () => ({
  BrowserDocumentPage: () => <div data-testid="browser-document-page" />,
}))
vi.mock('./pages/BrowserIndexPage.js', () => ({
  BrowserIndexPage: () => <div data-testid="browser-index-page" />,
}))
vi.mock('./pages/ReplicaReadPage.js', () => ({
  ReplicaReadPage: () => <div data-testid="replica-read-page" />,
}))
vi.mock('./pages/DaemonDocumentPage.js', () => ({
  DaemonDocumentPage: (props: Record<string, unknown>) => (
    <div data-testid="daemon-document-page" data-workspace={String(props.workspace)} />
  ),
}))

const DAEMON_STATE: ProviderState = { kind: 'daemon', daemonBaseUrl: 'http://127.0.0.1:3099' }

/**
 * The arrangement the defect needs, and every part of it is load-bearing.
 *
 * TWO workspaces, because with one there is nothing for a fallback to pick
 * instead. The FIRST has no segment, so its only handle is the raw canonical
 * id — which is what made the wrong answer visible in the address bar rather
 * than silently plausible. The SECOND is the one the address names.
 */
const NO_SEGMENT_ID = '01M2219007M9F7R9EWCXS3PFJ7'
const ADDRESSED_ID = '01M231FG6BGKKWW4BAA6Z1C945'

/**
 * How many address writes a settle may take before it is a loop rather than a
 * settle. The report counted several hundred in eight seconds; a settle needs
 * at most one rewrite to finish the sentence.
 *
 * Two things about it are worth knowing before trusting it.
 *
 * The UNBOUNDED loop — the one that was reported — does not reach an
 * assertion at all. Measured: removing the page's address-aware first pick
 * makes this file hang past 300s, because the loop is synchronous and
 * vitest's own timeout never fires, and the worker dies with SIGABRT. That is
 * still a failure and still names this file, but it is not this ceiling that
 * reports it. Throwing from inside the router subscription was tried as a way
 * to make it legible; it does not break the loop.
 *
 * And the ceiling itself is UNPROVEN against a bounded loop: no mutation
 * found so far lands between "settles once" and "hangs forever" (dropping
 * App's replay guard leaves the count unchanged, since the
 * already-at-the-path early return still stops it). The FLOOR below is the
 * mutation-checked half — it is 0 in the addressed case above, so a
 * subscription that was never wired fails here.
 */
const NAVIGATION_CEILING = 8

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installDaemonFetch() {
  const documentsAsked: string[] = []
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (url.endsWith('/api/workspaces') && method === 'GET') {
      return Promise.resolve(
        jsonResponse({
          workspaces: [
            { workspaceId: NO_SEGMENT_ID, displayName: 'First listed' },
            { workspaceId: ADDRESSED_ID, segment: 'default', displayName: 'Default' },
          ],
        }),
      )
    }
    const documents = url.match(/\/api\/workspaces\/([^/]+)\/documents$/)
    if (documents && method === 'GET') {
      // The page asks by HANDLE, which for the addressed workspace is its
      // segment and for the segment-less one is the raw canonical id — the
      // whole reason this arrangement makes the wrong answer visible.
      const handle = decodeURIComponent(documents[1] as string)
      documentsAsked.push(handle)
      if (handle !== 'default' && handle !== ADDRESSED_ID) {
        return Promise.resolve(jsonResponse({ documents: [] }))
      }
      return Promise.resolve(
        jsonResponse({
          documents: [
            {
              id: 'doc-1',
              // At the root of the workspace on purpose: a nested path draws
              // its FOLDER in the column and the row only once it is opened,
              // and this test is about which workspace answered, not about
              // the tree.
              path: 'font-check',
              kind: 'spatial',
              displayName: 'Font check',
              updatedAt: '2026-09-10T00:00:00.000Z',
            },
          ],
        }),
      )
    }
    if (url.match(/\/api\/workspaces\/[^/]+\/trash$/)) {
      return Promise.resolve(jsonResponse({ entries: [] }))
    }
    // Answered rather than 404'd: App asks the daemon for its installed faces
    // as soon as it has a target, and a refusal there is a REPORTED failure
    // the jsdom guard would fail this file for. Nothing here is about fonts.
    if (url.endsWith('/api/fonts')) return Promise.resolve(jsonResponse({ fonts: [] }))
    return Promise.resolve(jsonResponse({}, 404))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { documentsAsked }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('opens the workspace the address names, not the one the daemon lists first', async () => {
  const { documentsAsked } = installDaemonFetch()
  const router = createMemoryRouter(
    [{ path: '*', element: <App providerState={DAEMON_STATE} /> }],
    {
      initialEntries: ['/w/default'],
    },
  )
  await act(async () => {
    render(<RouterProvider router={router} />)
  })

  // The addressed workspace's own document — the page cannot show this while
  // it is looking at the other workspace, whose list is empty.
  await screen.findByText('Font check')
  expect(router.state.location.pathname).toBe('/w/default')
  // And it never went looking in the first-listed one, which is what the
  // sticky selection did: it resolved that workspace, asked for its
  // documents, and only then met the address.
  expect(documentsAsked).not.toContain(NO_SEGMENT_ID)
})

it('settles an address that named no workspace once, instead of trading it', async () => {
  // From `/`, which names no workspace: the app resolves one and writes it
  // down, and that write is the whole subject here. The report's other half
  // was that this settle never finished — the address was rewritten several
  // hundred times inside eight seconds, so the document route never survived
  // long enough to load.
  //
  // The count is asserted from BOTH sides. A ceiling alone passes at zero,
  // which is also what a subscription that was never wired reports, and the
  // addressed case above really does settle at zero — so the floor is what
  // says this test is watching anything at all.
  installDaemonFetch()
  const router = createMemoryRouter(
    [{ path: '*', element: <App providerState={DAEMON_STATE} /> }],
    {
      initialEntries: ['/'],
    },
  )
  let navigations = 0
  const stop = router.subscribe(() => {
    navigations += 1
  })
  await act(async () => {
    render(<RouterProvider router={router} />)
  })
  await waitFor(() => {
    expect(router.state.location.pathname).not.toBe('/')
  })
  // A beat for anything the settle would have kicked off.
  await act(async () => {
    await Promise.resolve()
  })
  stop()

  expect(navigations).toBeGreaterThanOrEqual(1)
  expect(navigations).toBeLessThanOrEqual(NAVIGATION_CEILING)
  // First-listed, because nothing in the address asked for the other one —
  // the standing fallback, and the workspace whose handle is its raw id.
  expect(router.state.location.pathname).toBe(`/w/${NO_SEGMENT_ID}`)
})

it('keeps a DOCUMENT address whole while the workspace settles', async () => {
  // The report's actual entry point. The workspace resolve and the document
  // route are two different rewriters, and the document half is what the
  // person asked for — a workspace settle that drops it lands them on a list.
  installDaemonFetch()
  const router = createMemoryRouter(
    [{ path: '*', element: <App providerState={DAEMON_STATE} /> }],
    {
      initialEntries: ['/w/default/d/font-check'],
    },
  )
  await act(async () => {
    render(<RouterProvider router={router} />)
  })

  await waitFor(() => {
    expect(screen.getByTestId('daemon-document-page')).not.toBeNull()
  })
  expect(router.state.location.pathname).toBe('/w/default/d/font-check')
})
