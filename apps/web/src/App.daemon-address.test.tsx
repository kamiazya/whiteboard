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

/**
 * What a cold load of this two-workspace arrangement COSTS, per endpoint,
 * measured rather than assumed (three consecutive runs, 2026-09-21).
 *
 * This is the instrument the navigation ceiling above could not be. The
 * storm this file is named for was counted in REQUESTS — two thirds of it
 * `/document-tags`, an endpoint whose answer nobody blocks on — and a
 * settle that rewrites the address once while asking for the same document
 * list ten times is a storm that the ceiling reports as fine.
 *
 * Read the numbers before trusting them, because they are not 1:
 *
 * | endpoint  | addressed (`/w/default`) | settled from `/` |
 * |-----------|--------------------------|------------------|
 * | workspaces| 1-2 (varies by timing)   | 2                |
 * | documents | 3                        | 1                |
 * | names     | 3                        | 1                |
 * | tags      | 4                        | 0                |
 * | trash     | 2                        | 1                |
 *
 * The addressed path asks for ONE workspace's documents THREE times, and
 * for its tag vocabulary four times. That is duplicate work, it is stable,
 * and it is not what this file was opened to fix — so it is pinned here as
 * what IS rather than what should be, and reducing it is its own change
 * with its own before/after. Pinning it is what makes that change legible:
 * whoever lowers these numbers will see them move.
 *
 * A ceiling AND a floor, because a fixture that answers nothing also
 * reports zero, which is the failure these numbers are meant to catch.
 */
const COLD_LOAD_BUDGET = {
  addressed: { workspaces: 2, documents: 2, names: 2, tags: 2, trash: 2 },
  settled: { workspaces: 2, documents: 1, names: 1, tags: 0, trash: 1 },
} as const

function expectWithinBudget(
  counts: Record<Endpoint, number>,
  budget: { workspaces: number; documents: number; names: number; tags: number; trash: number },
) {
  for (const [endpoint, ceiling] of Object.entries(budget)) {
    expect(
      counts[endpoint as Endpoint],
      `${endpoint} requests on one cold load (budget ${ceiling})`,
    ).toBeLessThanOrEqual(ceiling)
  }
  // The floor: a cold load that reached the daemon at all asked for the
  // workspace list and one workspace's documents. Without this, a fixture
  // wired to nothing passes every ceiling above.
  expect(counts.workspaces).toBeGreaterThanOrEqual(1)
  expect(counts.documents).toBeGreaterThanOrEqual(1)
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Every endpoint a cold load of this arrangement can reach. `names` and
 * `tags` answer 404 here (they always have — the page treats both as
 * optional), but they are COUNTED, because the storm this file is named for
 * was two thirds `/document-tags`: an endpoint whose answer nobody needs is
 * exactly where repetition hides.
 */
type Endpoint = 'workspaces' | 'documents' | 'names' | 'tags' | 'trash' | 'fonts' | 'other'

/** Which endpoint a request is, by URL alone — so the fixture only counts. */
function endpointOf(url: string, method: string): Endpoint {
  if (url.endsWith('/api/workspaces') && method === 'GET') return 'workspaces'
  if (/\/api\/workspaces\/[^/]+\/documents$/.test(url) && method === 'GET') return 'documents'
  if (/\/api\/workspaces\/[^/]+\/names$/.test(url)) return 'names'
  if (url.includes('/document-tags')) return 'tags'
  if (/\/api\/workspaces\/[^/]+\/trash$/.test(url)) return 'trash'
  if (url.endsWith('/api/fonts')) return 'fonts'
  return 'other'
}

/**
 * At the root of the workspace on purpose: a nested path draws its FOLDER in
 * the column and the row only once it is opened, and these cases are about
 * which workspace answered, not about the tree.
 */
const SEEDED_DOCUMENT = {
  id: 'doc-1',
  path: 'font-check',
  kind: 'spatial',
  displayName: 'Font check',
  updatedAt: '2026-09-10T00:00:00.000Z',
}

function emptyCounts(): Record<Endpoint, number> {
  return { workspaces: 0, documents: 0, names: 0, tags: 0, trash: 0, fonts: 0, other: 0 }
}

function installDaemonFetch() {
  const documentsAsked: string[] = []
  const counts = emptyCounts()
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    counts[endpointOf(url, method)] += 1
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
      return Promise.resolve(jsonResponse({ documents: [SEEDED_DOCUMENT] }))
    }
    if (url.match(/\/api\/workspaces\/[^/]+\/trash$/)) {
      return Promise.resolve(jsonResponse({ entries: [] }))
    }
    // Answered rather than 404'd: App asks the daemon for its installed faces
    // as soon as it has a target, and a refusal there is a REPORTED failure
    // the jsdom guard would fail this file for. Nothing here is about fonts.
    if (url.endsWith('/api/fonts')) return Promise.resolve(jsonResponse({ fonts: [] }))
    // `names` and `document-tags` land here too: both answer 404 and always have
    // (the page treats each as optional), and both are counted above.
    return Promise.resolve(jsonResponse({}, 404))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { documentsAsked, counts }
}

/** Lets a settle's own follow-up requests land before the counts are read. */
async function settleRequests() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('opens the workspace the address names, not the one the daemon lists first', async () => {
  const { documentsAsked, counts } = installDaemonFetch()
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
  await settleRequests()
  expectWithinBudget(counts, COLD_LOAD_BUDGET.addressed)
})

it('costs the same to address a workspace by its canonical id as by its segment', async () => {
  // ADR-0019 gives a workspace TWO handle forms, and every guard in the
  // address sync compares PATHNAMES rather than the workspace a pathname
  // resolves to — so the id form is a distinct address for the same
  // workspace, and it is the form no other test in this repo drives. If a
  // guard is defeated by it, the cost shows up here as a count, on the one
  // endpoint each duplicated round would touch.
  const { documentsAsked, counts } = installDaemonFetch()
  const router = createMemoryRouter(
    [{ path: '*', element: <App providerState={DAEMON_STATE} /> }],
    { initialEntries: [`/w/${ADDRESSED_ID}`] },
  )
  await act(async () => {
    render(<RouterProvider router={router} />)
  })

  await screen.findByText('Font check')
  // It normalises to the segment, which is the handle the workspace prefers.
  await waitFor(() => {
    expect(router.state.location.pathname).toBe('/w/default')
  })
  expect(documentsAsked).not.toContain(NO_SEGMENT_ID)
  await settleRequests()
  expectWithinBudget(counts, COLD_LOAD_BUDGET.addressed)
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
  const { counts } = installDaemonFetch()
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
  await settleRequests()
  expectWithinBudget(counts, COLD_LOAD_BUDGET.settled)
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
