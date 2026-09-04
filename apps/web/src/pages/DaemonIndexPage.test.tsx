import {
  act,
  cleanup,
  fireEvent,
  type RenderOptions,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESTRUCTIVE_COPY } from '@/lib/destructive-copy'
import { pickNewDocumentKind } from '../test-utils/new-document-menu.js'
import { DaemonIndexPage } from './DaemonIndexPage.js'

// The page now reads useNavigate (Settings navigation), so every render
// needs a Router ancestor — wrapping once here keeps the existing
// `render(<DaemonIndexPage .../>)` call sites throughout this file unchanged.
function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>, options)
}

/**
 * Switches the workspace the way the app now does it: the shell moves the
 * address, and the page follows the prop. Through the same wrapper `render`
 * uses — the page reads `useSearchParams`, so a bare rerender of the page
 * alone throws before it can follow anything.
 */
function switchWorkspace(
  rerender: (ui: ReactElement) => void,
  workspace: string,
  onOpenDocument = vi.fn(),
) {
  rerender(
    <MemoryRouter initialEntries={['/']}>
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspace={workspace}
        onOpenDocument={onOpenDocument}
      />
    </MemoryRouter>,
  )
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

// A real canonical id, so a test that says "not the raw identifier" is
// checking against the shape ADR-0019 actually mints.
const WS_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// The list contract requires id and kind on every row (the daemon always
// serves both); fixtures may omit them for brevity and get daemon-shaped
// defaults filled in here.
function withSummaryDefaults(
  rows: Array<{
    path: string
    updatedAt: string
    id?: string
    kind?: string
    displayName?: string
  }>,
) {
  return rows.map((row) => ({ id: `id-${row.path}`, kind: 'spatial', ...row }))
}

interface MockRoutes {
  workspaces: Array<{ workspaceId: string; segment?: string; displayName?: string }>
  documentsByWorkspace: Record<
    string,
    Array<{ path: string; updatedAt: string; id?: string; kind?: string; displayName?: string }>
  >
  namesByWorkspace?: Record<
    string,
    { workspace?: string; documents: Record<string, string>; pinned: string[] } | 'fail'
  >
  onCreateDocument?: (workspaceId: string, path: string, kind?: string) => void
  // Return a Response (or a pending promise of one) to override the
  // default 200 {ok:true}.
  onDeleteCanvas?: (workspaceId: string, path: string) => Response | Promise<Response> | undefined
  snapshotByCanvas?: Record<string, Uint8Array>
  onUpdateCanvas?: (workspaceId: string, path: string, bytes: Uint8Array) => void
  onSetCanvasName?: (workspaceId: string, path: string, name: string) => void
  /** When set, the documents fetch resolves only after this promise settles. */
  delayCanvases?: Promise<void>
  /** Same, for the workspaces list. Consulted per call, so a test can leave
   *  it unset for the initial load and set it before the re-list. */
  delayWorkspaces?: Promise<void>
  /** Override the documents GET. Return undefined to fall through to the
   *  default. Consulted per call, so a test can answer 404 once and then
   *  behave normally — a workspace deleted out from under the page. */
  onListDocuments?: (workspaceId: string) => Response | undefined
  /** Override the workspaces GET. Return undefined to fall through to the
   *  default. Consulted per call, so a test can answer 500 only on the
   *  re-list a switch triggers. */
  onListWorkspaces?: () => Response | undefined
  /** Rows the trash GET answers with; defaults to an empty trash. */
  trashByWorkspace?: Record<string, Array<{ documentId: string; path: string; deletedAt: number }>>
}

function installFetchMock(routes: MockRoutes) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/workspaces') && (!init || init.method === undefined)) {
      const override = routes.onListWorkspaces?.()
      if (override) return Promise.resolve(override)
      const respond = () => jsonResponse({ workspaces: routes.workspaces })
      // Held open so a test can inspect what renders WHILE the re-list is in
      // flight — the window in which a deleted workspace is still selected.
      if (routes.delayWorkspaces) return routes.delayWorkspaces.then(respond)
      return Promise.resolve(respond())
    }
    const documentsMatch = url.match(/\/api\/workspaces\/([^/]+)\/documents$/)
    if (documentsMatch && (!init || init.method === undefined)) {
      const workspaceId = decodeURIComponent(documentsMatch[1])
      const override = routes.onListDocuments?.(workspaceId)
      if (override) return Promise.resolve(override)
      const documents = routes.documentsByWorkspace[workspaceId]
      if (!documents) return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
      const respond = () => jsonResponse({ documents: withSummaryDefaults(documents) })
      if (routes.delayCanvases) return routes.delayCanvases.then(respond)
      return Promise.resolve(respond())
    }
    if (documentsMatch && init?.method === 'POST') {
      const workspaceId = decodeURIComponent(documentsMatch[1])
      const body = JSON.parse(String(init.body)) as { path: string; kind?: string }
      routes.onCreateDocument?.(workspaceId, body.path, body.kind)
      return Promise.resolve(jsonResponse({ path: body.path }))
    }
    const canvasDeleteMatch = url.match(/\/api\/workspaces\/([^/]+)\/documents\/([^/]+)$/)
    if (canvasDeleteMatch && init?.method === 'DELETE') {
      const workspaceId = decodeURIComponent(canvasDeleteMatch[1])
      const path = decodeURIComponent(canvasDeleteMatch[2])
      const override = routes.onDeleteCanvas?.(workspaceId, path)
      return Promise.resolve(override ?? jsonResponse({ ok: true }))
    }
    const trashMatch = url.match(/\/api\/workspaces\/([^/]+)\/trash$/)
    if (trashMatch && (!init || init.method === undefined)) {
      const workspaceId = decodeURIComponent(trashMatch[1])
      return Promise.resolve(
        jsonResponse({ entries: routes.trashByWorkspace?.[workspaceId] ?? [] }),
      )
    }
    const namesMatch = url.match(/\/api\/workspaces\/([^/]+)\/names$/)
    if (namesMatch) {
      const workspaceId = decodeURIComponent(namesMatch[1])
      const names = routes.namesByWorkspace?.[workspaceId]
      if (names === 'fail' || !names) {
        return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
      }
      return Promise.resolve(jsonResponse(names))
    }
    const snapshotMatch = url.match(/\/api\/w\/([^/]+)\/document\/(.+)\/snapshot$/)
    if (snapshotMatch) {
      const path = decodeURIComponent(snapshotMatch[2])
      const bytes = routes.snapshotByCanvas?.[path]
      if (!bytes) return Promise.resolve(jsonResponse({ title: 'Not found' }, 404))
      return Promise.resolve(
        new Response(bytes as BodyInit, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      )
    }
    const updateMatch = url.match(/\/api\/w\/([^/]+)\/document\/(.+)\/update$/)
    if (updateMatch && init?.method === 'POST') {
      const workspaceId = decodeURIComponent(updateMatch[1])
      const path = decodeURIComponent(updateMatch[2])
      routes.onUpdateCanvas?.(workspaceId, path, new Uint8Array(init.body as ArrayBuffer))
      return Promise.resolve(jsonResponse({ ok: true }))
    }
    const canvasNameMatch = url.match(/\/api\/workspaces\/([^/]+)\/documents\/([^/]+)\/name$/)
    if (canvasNameMatch && init?.method === 'PUT') {
      const workspaceId = decodeURIComponent(canvasNameMatch[1])
      const path = decodeURIComponent(canvasNameMatch[2])
      const body = JSON.parse(String(init.body)) as { name: string }
      routes.onSetCanvasName?.(workspaceId, path, body.name)
      const names = routes.namesByWorkspace?.[workspaceId]
      const documents = names && names !== 'fail' ? names.documents : {}
      return Promise.resolve(
        jsonResponse({ documents: { ...documents, [path]: body.name }, pinned: [] }),
      )
    }
    return Promise.resolve(jsonResponse({}, 404))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// The panel's document cards fill the preview pane on click; Open /
// Duplicate / Delete live there, so acting on a document is select-then-act.
async function selectCard(name: string) {
  fireEvent.click(await screen.findByText(name))
  await screen.findByTestId('okf-preview')
}

describe('DaemonIndexPage', () => {
  it('renders one card per document of the selected workspace with display name and relative updatedAt', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        // displayName rides on the list row exactly as the daemon's
        // documents table serves it; /names projects the same column.
        'ws-a': [
          { path: 'alpha', displayName: 'Alpha Board', updatedAt: new Date().toISOString() },
        ],
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: {
        'ws-a': { documents: { alpha: 'Alpha Board' }, pinned: [] },
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    expect(await screen.findByText('Alpha Board')).toBeTruthy()
    expect(screen.getByTestId('card-subtitle').textContent).toMatch(/ago/)
    expect(screen.queryByText('beta')).toBeNull()
  })

  it('marks a markdown row from the daemon list response as markdown on its card', async () => {
    // The read direction of `kind`: the daemon's documents-list response maps
    // into DocumentRow and reaches the card's text marker. The create/POST
    // direction is covered separately; without this test every page-level
    // mock defaults to spatial and the mapping could silently drop kind.
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [
          { path: 'note', updatedAt: new Date().toISOString(), kind: 'markdown' },
          { path: 'board', updatedAt: new Date().toISOString() },
        ],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('note')

    // The kind marker is the card's icon badge; the thumbnail placeholder is
    // excluded because it labels unknown kinds "markdown" too.
    const cards = screen.getAllByRole('button', { name: /note|board/ })
    const noteCard = cards.find((c) => within(c).queryByText('note'))!
    const boardCard = cards.find((c) => within(c).queryByText('board'))!
    expect(within(noteCard).getByTestId('card-kind-badge').getAttribute('data-kind')).toBe(
      'markdown',
    )
    expect(within(boardCard).getByTestId('card-kind-badge').getAttribute('data-kind')).not.toBe(
      'markdown',
    )
  })

  it('keeps a create entry point when the canvas list fails to load', async () => {
    // A failed listDocuments must not dead-end the page: creating routes
    // around the broken list (the POST needs no rows, and success navigates
    // away), so the error state keeps the same recovery path the toolbar
    // used to provide.
    const created: Array<[string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {},
      onCreateDocument: (workspaceId, path) => created.push([workspaceId, path]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    expect(await screen.findByRole('alert')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('ws-a', 'untitled'))
    expect(created).toEqual([['ws-a', 'untitled']])
  })

  it('fades the loaded panel in for skeleton-to-content continuity', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    const panel = await screen.findByTestId('workspace-files-panel')
    const wrapper = panel.closest('.animate-in') as HTMLElement | null
    expect(wrapper).not.toBeNull()
    expect(wrapper?.className).toMatch(/\bfade-in-0\b/)
  })

  // A 404 from the documents list means the workspace is GONE, not empty: an
  // existing workspace with no documents answers 200 with an empty array
  // (measured against the real route). And `selectedWorkspace` is only ever
  // set from `GET /api/workspaces`, so the only way to reach this is that the
  // workspace was deleted after that list was taken — by an agent, another
  // tab, or the CLI.
  //
  // Re-listing is the repair: the selection is what went stale, so replacing
  // it is what fixes the page. Showing an empty create-into-it state instead
  // would hide a real anomaly, and creating into a workspace that no longer
  // exists would silently make a DIFFERENT one.
  it('re-lists and selects another workspace when the selected one has been deleted', async () => {
    const routes: Parameters<typeof installFetchMock>[0] = {
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
      onListDocuments: (workspaceId) => {
        if (workspaceId !== 'ws-a') return undefined
        // ws-a is gone; the workspace list the page already holds is stale.
        routes.workspaces = [{ workspaceId: 'ws-b' }]
        return jsonResponse({ title: 'Workspace "ws-a" not found' }, 404)
      },
    }
    installFetchMock(routes)

    const onWorkspaceResolved = vi.fn()
    render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        onWorkspaceResolved={onWorkspaceResolved}
        onOpenDocument={vi.fn()}
      />,
    )

    // Lands on ws-b's documents rather than an empty state for a workspace
    // that is not there.
    expect(await screen.findByText('beta')).toBeTruthy()
    // And REPORTS it, which is now the only way the choice becomes visible:
    // the page owns no control of its own, so what it settled on reaches the
    // address bar through this callback or not at all.
    await waitFor(() => expect(onWorkspaceResolved).toHaveBeenCalledWith('ws-b'))
  })

  // The loop guard, which the case above does NOT exercise: there the server
  // stops listing the deleted workspace, so `ids[0]` happens to be the right
  // answer and picking "any other" is indistinguishable from picking "first".
  // Here the list and the documents disagree — the workspace is still listed
  // but 404s — and selecting it again would send the page back through the
  // same path forever.
  it('does not re-select the stale workspace when the list still reports it', async () => {
    let staleFetches = 0
    const routes: Parameters<typeof installFetchMock>[0] = {
      // ws-a is never removed from the listing, on purpose.
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
      onListDocuments: (workspaceId) => {
        if (workspaceId !== 'ws-a') return undefined
        staleFetches += 1
        return jsonResponse({ title: 'Workspace "ws-a" not found' }, 404)
      },
    }
    installFetchMock(routes)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    expect(await screen.findByText('beta')).toBeTruthy()
    // Counted rather than merely landing on ws-b: re-selecting the stale one
    // would still reach ws-b eventually in some orderings, and the defect
    // this pins is the repetition, not the destination.
    expect(staleFetches).toBe(1)
  })

  // The window between "this workspace is gone" and "here is another one".
  // Marking the load COMPLETE during it renders the onboarding empty state for
  // a workspace that does not exist, Create button live — and that button
  // passes `createWorkspace: true`, so a fast click would silently make a
  // different workspace. The page must stay in its loading state until the
  // re-list has actually chosen something.
  it('does not offer the empty-workspace create state while re-listing', async () => {
    let staleFetches = 0
    let releaseRelist!: () => void
    const relistGate = new Promise<void>((resolve) => {
      releaseRelist = resolve
    })
    const routes: Parameters<typeof installFetchMock>[0] = {
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
      onListDocuments: (workspaceId) => {
        if (workspaceId !== 'ws-a') return undefined
        staleFetches += 1
        // Only the re-list is held open; the first workspaces GET already ran.
        routes.delayWorkspaces = relistGate
        routes.workspaces = [{ workspaceId: 'ws-b' }]
        return jsonResponse({ title: 'Workspace "ws-a" not found' }, 404)
      },
    }
    installFetchMock(routes)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    // Land INSIDE the window deliberately: wait until the 404 has actually
    // been served, then flush the render it causes. Sampling earlier would
    // catch the initial load's skeleton and pass whatever the 404 path does —
    // the assertion has to be about the state AFTER the failure.
    await waitFor(() => {
      expect(staleFetches).toBe(1)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.getByRole('status', { name: 'Loading documents' })).toBeTruthy()

    releaseRelist()
    expect(await screen.findByText('beta')).toBeTruthy()
  })

  it('honors the addressed workspace over the daemon-listed first workspace', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
    })

    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} workspace="ws-b" onOpenDocument={vi.fn()} />,
    )

    expect(await screen.findByText('beta')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it('falls back to the first-listed workspace when the addressed workspace is not in the daemon list', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
    })

    render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspace="stale-deleted-workspace"
        onOpenDocument={vi.fn()}
      />,
    )

    expect(await screen.findByText('alpha')).toBeTruthy()
  })

  it('reports the fallback when the address moves to a workspace the daemon does not have', async () => {
    // A bookmark of a deleted workspace, opened while the app is already
    // running. The page falls back to first-listed, which is the standing
    // behaviour — but the FALLBACK has to reach the address, or the page
    // serves one workspace under an address naming another and every document
    // created lands somewhere the URL does not say.
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
    })
    const onWorkspaceResolved = vi.fn()
    const { rerender } = render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspace="ws-a"
        onWorkspaceResolved={onWorkspaceResolved}
        onOpenDocument={vi.fn()}
      />,
    )
    expect(await screen.findByText('alpha')).toBeTruthy()
    onWorkspaceResolved.mockClear()

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <DaemonIndexPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspace="ws-gone"
          onWorkspaceResolved={onWorkspaceResolved}
          onOpenDocument={vi.fn()}
        />
      </MemoryRouter>,
    )

    // The selection does not move — ws-a is still the right answer — so the
    // report is the ONLY signal, and it has to fire anyway.
    await waitFor(() => expect(onWorkspaceResolved).toHaveBeenCalledWith('ws-a'))
    expect(screen.getByText('alpha')).toBeTruthy()
  })

  it('finds a workspace created since its list was read, instead of falling back off it', async () => {
    // The switcher is the SHELL's, and it writes through its own source. This
    // page's `workspaces` is a snapshot taken before that write, so a freshly
    // created workspace is ABSENT from it — and a handle the list does not
    // hold used to mean one thing only: a stale bookmark, fall back to
    // first-listed. So creating a workspace from the switcher landed on a
    // different workspace and rewrote the address to name it.
    const routes = {
      workspaces: [{ workspaceId: 'ws-a' }] as Array<{ workspaceId: string; segment?: string }>,
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-new': [{ path: 'freshly-made', updatedAt: new Date().toISOString() }],
      },
    }
    installFetchMock(routes)
    const onWorkspaceResolved = vi.fn()
    const { rerender } = render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspace="ws-a"
        onWorkspaceResolved={onWorkspaceResolved}
        onOpenDocument={vi.fn()}
      />,
    )
    expect(await screen.findByText('alpha')).toBeTruthy()
    onWorkspaceResolved.mockClear()

    // What the switcher's create did: the daemon now holds it, and the
    // address moved onto it.
    routes.workspaces.push({ workspaceId: 'ws-new' })
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <DaemonIndexPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspace="ws-new"
          onWorkspaceResolved={onWorkspaceResolved}
          onOpenDocument={vi.fn()}
        />
      </MemoryRouter>,
    )

    expect(await screen.findByText('freshly-made')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(onWorkspaceResolved).not.toHaveBeenCalledWith('ws-a')
  })

  it('does not leave the old workspace usable when the re-list for a new one fails', async () => {
    // The refetch above is a second chance, not a guarantee. When it fails the
    // page still holds the PREVIOUS workspace selected while the address names
    // the new one — and a create from that state posts the document to the
    // workspace the URL does not name. The same mismatch the stale-address
    // branch below already refuses to leave behind.
    let workspaceCalls = 0
    const routes = {
      workspaces: [{ workspaceId: 'ws-a' }] as Array<{ workspaceId: string; segment?: string }>,
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
      onListWorkspaces: () => {
        workspaceCalls += 1
        // The first load settles the page; the re-list a switch triggers fails.
        return workspaceCalls === 1 ? undefined : jsonResponse({ message: 'nope' }, 500)
      },
    }
    installFetchMock(routes)
    const onOpenDocument = vi.fn()
    const { rerender } = render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspace="ws-a"
        onOpenDocument={onOpenDocument}
      />,
    )
    expect(await screen.findByText('alpha')).toBeTruthy()

    rerender(
      <MemoryRouter initialEntries={['/']}>
        <DaemonIndexPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspace="ws-new"
          onOpenDocument={onOpenDocument}
        />
      </MemoryRouter>,
    )

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    // The error state offers `Create a canvas` only while a workspace is still
    // SELECTED, and that selection would be the one the address just left. So
    // the affordance itself is the evidence: a create here posts the document
    // to `ws-a` under an address naming `ws-new`.
    expect(screen.queryByRole('button', { name: /create a canvas/i })).toBeNull()
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it('follows a segment the workspace was renamed to a moment ago', async () => {
    // The rename half of the same shape. `onSwitch` carries the NEW segment,
    // which the page's pre-rename snapshot spells the old way — so the
    // resolve missed and the page fell off the workspace the person had just
    // renamed, onto first-listed.
    const routes = {
      workspaces: [
        { workspaceId: WS_ULID, segment: 'studio' },
        { workspaceId: 'ws-other' },
      ] as Array<{ workspaceId: string; segment?: string }>,
      // Keyed by HANDLE, which for a workspace holding a segment is that
      // segment — the page addresses the daemon by what it settled on, not by
      // the canonical id. Both spellings are present because the rename below
      // moves which one it asks for.
      documentsByWorkspace: {
        studio: [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        marketing: [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-other': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
    }
    installFetchMock(routes)
    const onWorkspaceResolved = vi.fn()
    const { rerender } = render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspace="studio"
        onWorkspaceResolved={onWorkspaceResolved}
        onOpenDocument={vi.fn()}
      />,
    )
    expect(await screen.findByText('alpha')).toBeTruthy()
    onWorkspaceResolved.mockClear()

    routes.workspaces[0] = { workspaceId: WS_ULID, segment: 'marketing' }
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <DaemonIndexPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspace="marketing"
          onWorkspaceResolved={onWorkspaceResolved}
          onOpenDocument={vi.fn()}
        />
      </MemoryRouter>,
    )

    await waitFor(() => expect(onWorkspaceResolved).toHaveBeenCalledWith('marketing'))
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.queryByText('beta')).toBeNull()
  })

  it('follows the workspace the address names when it changes under the page', async () => {
    // The switcher is the SHELL's now, and it changes the address; the page
    // renders whatever workspace the address names. Until this, `workspace`
    // was an INITIAL value — read once at mount — so a switch from outside
    // moved the URL and left the cards where they were.
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
    })

    const { rerender } = render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} workspace="ws-a" onOpenDocument={vi.fn()} />,
    )
    expect(await screen.findByText('alpha')).toBeTruthy()

    // Through the same MemoryRouter wrapper the helper renders with: the page
    // reads `useSearchParams`, so a bare rerender of the page alone throws
    // before it can follow anything.
    rerender(
      <MemoryRouter initialEntries={['/']}>
        <DaemonIndexPage
          daemonBaseUrl={DAEMON_BASE_URL}
          workspace="ws-b"
          onOpenDocument={vi.fn()}
        />
      </MemoryRouter>,
    )

    expect(await screen.findByText('beta')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it("clears the previous workspace's cards immediately on switch, before the new load resolves", async () => {
    // A stale card clicked in the switch window would pair the NEW workspace
    // id with the OLD workspace's path — a mismatched identity.
    // Each pending call gets its own deferred + fresh Response (a Response
    // body is single-use, and the load may retry/refire).
    // The panel re-reads ws-b AFTER the page's rows arrive, so the gate
    // must stay open once released — a one-shot release would strand the
    // panel's own later fetch and 'beta' would never render.
    const waiters: Array<() => void> = []
    let released = false
    const releaseB = () => {
      released = true
      for (const w of waiters.splice(0)) w()
    }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }] }),
        )
      }
      if (url.includes('/ws-a/documents')) {
        return Promise.resolve(
          jsonResponse({
            documents: withSummaryDefaults([
              { path: 'alpha', updatedAt: new Date().toISOString() },
            ]),
          }),
        )
      }
      if (url.includes('/ws-b/documents')) {
        const respond = () =>
          jsonResponse({
            documents: withSummaryDefaults([{ path: 'beta', updatedAt: new Date().toISOString() }]),
          })
        if (released) return Promise.resolve(respond())
        return new Promise<Response>((resolve) => {
          waiters.push(() => resolve(respond()))
        })
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} workspace="ws-a" onOpenDocument={vi.fn()} />,
    )
    expect(await screen.findByText('alpha')).toBeTruthy()

    switchWorkspace(rerender, 'ws-b')

    // ws-b's documents request is still pending — the old grid must be gone NOW.
    expect(screen.queryByText('alpha')).toBeNull()

    releaseB()
    expect(await screen.findByText('beta')).toBeTruthy()
  })

  it('sorts pinned documents before unpinned in the folder pane', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [
          { path: 'old', updatedAt: '2020-01-01T00:00:00Z' },
          { path: 'new', updatedAt: '2026-01-01T00:00:00Z' },
          { path: 'pinned-one', updatedAt: '2019-01-01T00:00:00Z' },
        ],
      },
      namesByWorkspace: {
        'ws-a': { documents: {}, pinned: ['pinned-one'] },
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('pinned-one')

    // Non-vacuous: by the pane's path order alone, `pinned-one` sorts LAST.
    const titles = screen.getAllByTestId('card-title').map((el) => el.textContent)
    expect(titles).toEqual(['pinned-one', 'new', 'old'])
  })

  it('filters cards by search input matching path or display name', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [
          { path: 'alpha', updatedAt: new Date().toISOString() },
          { path: 'beta', updatedAt: new Date().toISOString() },
        ],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    fireEvent.change(screen.getByLabelText('Search documents'), { target: { value: 'bet' } })

    // The match highlight splits the title across a <mark>, so read the
    // row's textContent rather than matching a contiguous text node.
    expect(screen.queryByText('alpha')).toBeNull()
    const titles = (await screen.findAllByTestId('result-title')).map((el) => el.textContent)
    expect(titles).toEqual(['beta'])
  })

  it('degrades gracefully to unpinned/path-only when the names fetch fails', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: { 'ws-a': 'fail' },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    expect(await screen.findByText('alpha')).toBeTruthy()
  })

  it('shows an alert (not a blank page) when listDocuments fails for the selected workspace', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {},
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })

  it('shows an alert when the initial workspace list fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ message: 'boom' }, 500))),
    )

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    expect((await screen.findByRole('alert')).textContent).toBe('Failed to load workspaces.')
  })

  it('does not apply a slower, stale workspace response after switching to a newer workspace', async () => {
    let resolveA: ((res: Response) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }] }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        return new Promise<Response>((resolve) => {
          resolveA = resolve
        })
      }
      if (url.endsWith('/api/workspaces/ws-b/documents')) {
        return Promise.resolve(
          jsonResponse({
            documents: withSummaryDefaults([{ path: 'beta', updatedAt: new Date().toISOString() }]),
          }),
        )
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} workspace="ws-a" onOpenDocument={vi.fn()} />,
    )

    switchWorkspace(rerender, 'ws-b')
    expect(await screen.findByText('beta')).toBeTruthy()

    resolveA?.(
      jsonResponse({
        documents: withSummaryDefaults([{ path: 'alpha', updatedAt: new Date().toISOString() }]),
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('calls onOpenDocument with the card identity via the preview Open action', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await selectCard('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    expect(onOpenDocument).toHaveBeenCalledExactlyOnceWith('ws-a', 'alpha')
  })

  it('opens a document under the workspace segment, not its canonical id', async () => {
    // ADR-0019: the visible URL carries the human-readable segment. This page
    // is where a daemon URL is born — `onOpenDocument` is what App.tsx turns
    // into `/w/:handle/d/:path` — so a raw ULID handed over here is a
    // raw ULID in the address bar.
    installFetchMock({
      workspaces: [{ workspaceId: WS_ULID, segment: 'design-team' }],
      documentsByWorkspace: {
        // Keyed under BOTH so this test is about the handle `onOpenDocument`
        // receives, and not about which one the fetch used.
        [WS_ULID]: [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'design-team': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await selectCard('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    expect(onOpenDocument).toHaveBeenCalledExactlyOnceWith('design-team', 'alpha')
  })

  it('a canonical-id address still finds the workspace it names', async () => {
    // The durable half of segment-first resolution: an id-form URL is the
    // link that survives a rename, so it must keep selecting the workspace
    // even once that workspace answers to a name.
    installFetchMock({
      workspaces: [
        { workspaceId: 'ws-a', segment: 'alpha-space' },
        { workspaceId: WS_ULID, segment: 'design-team' },
      ],
      documentsByWorkspace: {
        'alpha-space': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
        'design-team': [{ path: 'beta', updatedAt: new Date().toISOString() }],
      },
    })

    render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspace={WS_ULID}
        onOpenDocument={vi.fn()}
      />,
    )

    expect(await screen.findByText('beta')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it('a workspace with no segment is still addressed by its id', async () => {
    // 0019 left a legacy workspace's segment NULL rather than inventing one,
    // so the id-as-handle path is not a legacy curiosity — it is live.
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-unnamed' }],
      documentsByWorkspace: {
        'ws-unnamed': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await selectCard('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))

    expect(onOpenDocument).toHaveBeenCalledExactlyOnceWith('ws-unnamed', 'alpha')
  })

  it('duplicates a canvas via the preview Duplicate action without opening it', async () => {
    const updates: Array<[string, string, Uint8Array]> = []
    const created: Array<[string, string]> = []
    const names: Array<[string, string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', displayName: 'Alpha', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: { 'ws-a': { documents: { alpha: 'Alpha' }, pinned: [] } },
      snapshotByCanvas: { alpha: new Uint8Array([1, 2, 3]) },
      onCreateDocument: (workspaceId, path) => created.push([workspaceId, path]),
      onUpdateCanvas: (workspaceId, path, bytes) => updates.push([workspaceId, path, bytes]),
      onSetCanvasName: (workspaceId, path, name) => names.push([workspaceId, path, name]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await selectCard('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    await waitFor(() => {
      expect(created).toEqual([['ws-a', 'alpha-copy']])
    })
    expect(updates).toEqual([['ws-a', 'alpha-copy', new Uint8Array([1, 2, 3])]])
    expect(names).toEqual([['ws-a', 'alpha-copy', 'Alpha (copy)']])
    // Clicking the Duplicate action must not also open the source canvas.
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('a second Duplicate press while one is in flight starts no second copy', async () => {
    let resolveSnapshot: ((res: Response) => void) | undefined
    let snapshotCalls = 0
    const created: Array<[string, string]> = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces') && (!init || init.method === undefined)) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && (!init || init.method === undefined)) {
        // markdown: the panel's thumbnail/preview loaders then read OKF (a
        // harmless 404 below) instead of racing this test's deferred
        // snapshot read, which must stay the duplicate's alone.
        return Promise.resolve(
          jsonResponse({
            documents: [
              {
                id: 'id-alpha',
                path: 'alpha',
                displayName: 'Alpha',
                updatedAt: new Date().toISOString(),
                kind: 'markdown',
              },
            ],
          }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { path: string }
        created.push(['ws-a', body.path])
        return Promise.resolve(jsonResponse({ path: body.path }))
      }
      if (url.endsWith('/api/workspaces/ws-a/names')) {
        return Promise.resolve(jsonResponse({ documents: { alpha: 'Alpha' }, pinned: [] }))
      }
      if (url.endsWith('/api/w/ws-a/document/alpha/snapshot')) {
        snapshotCalls++
        return new Promise<Response>((resolve) => {
          resolveSnapshot = resolve
        })
      }
      if (/\/api\/document\/ws-a\/[^/]+\/update$/.test(url) && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (/\/api\/workspaces\/ws-a\/documents\/[^/]+\/name$/.test(url) && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ documents: { alpha: 'Alpha' }, pinned: [] }))
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await selectCard('Alpha')
    const duplicateBtn = screen.getByRole('button', { name: 'Duplicate' })
    fireEvent.click(duplicateBtn)
    await waitFor(() => expect(snapshotCalls).toBe(1))

    // React has flushed the in-flight state by the second press; the
    // handler's guard must swallow it — no second snapshot read.
    fireEvent.click(duplicateBtn)
    expect(snapshotCalls).toBe(1)

    resolveSnapshot?.(
      new Response(new Uint8Array([1, 2, 3]) as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    )
    await waitFor(() => expect(created).toEqual([['ws-a', 'alpha-copy']]))
    vi.unstubAllGlobals()
  })

  it('shows an alert and keeps the Duplicate button usable when duplicating fails', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', displayName: 'Alpha', updatedAt: new Date().toISOString() }],
      },
      namesByWorkspace: { 'ws-a': { documents: { alpha: 'Alpha' }, pinned: [] } },
      // No snapshotByCanvas entry for 'alpha' -> the mock 404s the snapshot read.
    })
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await selectCard('Alpha')
    const duplicateBtn = screen.getByRole('button', { name: 'Duplicate' }) as HTMLButtonElement
    fireEvent.click(duplicateBtn)

    expect((await screen.findByRole('alert')).textContent).toMatch(/not found/i)
    expect(duplicateBtn.disabled).toBe(false)
  })

  it('does not apply a stale duplicate completion to a workspace the user has since switched away from', async () => {
    let resolveSnapshot: ((res: Response) => void) | undefined
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces') && (!init || init.method === undefined)) {
        return Promise.resolve(
          jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }] }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && (!init || init.method === undefined)) {
        return Promise.resolve(
          jsonResponse({
            documents: [
              {
                id: 'id-alpha',
                path: 'alpha',
                updatedAt: new Date().toISOString(),
                kind: 'markdown',
              },
            ],
          }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-b/documents') && (!init || init.method === undefined)) {
        return Promise.resolve(
          jsonResponse({
            documents: [
              {
                id: 'id-beta',
                path: 'beta',
                updatedAt: new Date().toISOString(),
                kind: 'markdown',
              },
            ],
          }),
        )
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { path: string }
        return Promise.resolve(jsonResponse({ path: body.path }))
      }
      if (
        url.endsWith('/api/workspaces/ws-a/names') ||
        url.endsWith('/api/workspaces/ws-b/names')
      ) {
        return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
      }
      if (url.endsWith('/api/w/ws-a/document/alpha/snapshot')) {
        return new Promise<Response>((resolve) => {
          resolveSnapshot = resolve
        })
      }
      if (/\/api\/document\/ws-a\/[^/]+\/update$/.test(url) && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      if (/\/api\/workspaces\/ws-a\/documents\/[^/]+\/name$/.test(url) && init?.method === 'PUT') {
        return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} workspace="ws-a" onOpenDocument={vi.fn()} />,
    )
    await selectCard('alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    // Switch workspaces while the duplicate (still reading alpha's snapshot) is in flight.
    switchWorkspace(rerender, 'ws-b')
    expect(await screen.findByText('beta')).toBeTruthy()

    resolveSnapshot?.(
      new Response(new Uint8Array([1, 2, 3]) as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The completed duplicate belongs to ws-a; the visible grid must still be
    // ws-b's, untouched by ws-a's post-duplicate refresh.
    expect(screen.getByText('beta')).toBeTruthy()
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.queryByText('alpha-copy')).toBeNull()
    vi.unstubAllGlobals()
  })

  it("creates a canvas from the panel's New menu, opening it with no name typed first", async () => {
    const created: Array<[string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'existing', updatedAt: new Date().toISOString() }],
      },
      onCreateDocument: (workspaceId, path) => created.push([workspaceId, path]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await screen.findByText('existing')

    await pickNewDocumentKind('spatial')

    await waitFor(() => expect(created).toEqual([['ws-a', 'untitled']]))
    // Creating ends where the next thing happens — an empty document is
    // worth nothing until it is open, and the panel was the last creation
    // path in the app that left you looking at a card instead. The open
    // folder is in the address now, so the way back is not a trip to the
    // workspace root.
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('ws-a', 'untitled'))
    // Still no form in front of it: naming does not gate creation.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('creates a markdown document from the panel button, sending kind to the daemon', async () => {
    const created: Array<[string, string, string | undefined]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'existing', updatedAt: new Date().toISOString() }],
      },
      onCreateDocument: (workspaceId, path, kind) => created.push([workspaceId, path, kind]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await screen.findByText('existing')

    await pickNewDocumentKind('markdown')

    await waitFor(() => expect(created).toEqual([['ws-a', 'untitled', 'markdown']]))
  })

  it('derives a unique path from the listed documents, skipping an already-used "untitled"', async () => {
    const created: Array<[string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'untitled', updatedAt: new Date().toISOString() }],
      },
      onCreateDocument: (workspaceId, path) => created.push([workspaceId, path]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    await screen.findByText('untitled')

    await pickNewDocumentKind('spatial')

    await waitFor(() => expect(created).toEqual([['ws-a', 'untitled-2']]))
  })

  it('shows an alert when create canvas fails', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ message: 'boom' }, 500))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        return Promise.resolve(jsonResponse({ documents: [] }))
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 500))
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    // Empty workspace: the empty state's create action is the entry point.
    fireEvent.click(await screen.findByRole('button', { name: 'Create a canvas' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Request failed (500).')
    expect(screen.queryByText(/boom/)).toBeNull()
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  // The `disabled` attribute only protects AFTER React re-renders. Two presses inside one tick
  // (a real double-click, or Enter held down) both run the handler, and a guard that reads
  // `creating` from the render closure still sees `false` in the second — so it must not be the
  // only defence. Two POSTs deriving the same path means the loser 409s.
  it('sends one create for two presses inside a single tick', async () => {
    const created: string[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        created.push(JSON.parse(String(init.body)).path as string)
        return Promise.resolve(jsonResponse({ path: 'untitled' }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        return Promise.resolve(jsonResponse({ documents: [] }))
      }
      return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    // Empty workspace: the empty state's create action is the direct-click
    // entry point (the toolbar + goes through a menu, which cannot fire
    // twice in one tick — its item unmounts on the first select).
    const button = await screen.findByRole('button', { name: 'Create a canvas' })

    // No await between them: React has not re-rendered, so `disabled` is not yet set.
    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalled())
    expect(created).toEqual(['untitled'])
  })

  it('disables the empty state create button while in flight, and double-clicking creates exactly one', async () => {
    let resolveCreate: ((res: Response) => void) | undefined
    const created: string[] = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        created.push(JSON.parse(String(init.body)).path as string)
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve
        })
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        return Promise.resolve(jsonResponse({ documents: [] }))
      }
      return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    const button = await screen.findByRole('button', { name: 'Create a canvas' })

    fireEvent.click(button)
    await waitFor(() => expect(created).toEqual(['untitled']))
    // The create is still in flight: the control must be disabled AND a second press a no-op.
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(true))
    fireEvent.click(button)
    expect(created).toEqual(['untitled'])

    resolveCreate?.(jsonResponse({ path: 'untitled' }))
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledTimes(1))
    expect(created).toEqual(['untitled'])
  })

  // Reproduces the defect the dev-loop's QA agent found: after a failed create the list was never
  // re-fetched, so the next click re-derived the SAME path from stale rows and collided again,
  // deterministically, until the user reloaded the page.
  it('re-reads the list after a failed create so the retry does not repeat the same path', async () => {
    const created: string[] = []
    let serverPaths: string[] = ['untitled']
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents') && init?.method === 'POST') {
        const path = JSON.parse(String(init?.body ?? '{}')).path as string
        created.push(path)
        if (serverPaths.includes(path)) {
          return Promise.resolve(jsonResponse({ title: `Canvas "${path}" already exists` }, 409))
        }
        serverPaths = [...serverPaths, path]
        return Promise.resolve(jsonResponse({ path }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        // The list starts EMPTY (a second tab created "untitled"), so the first derive collides.
        return Promise.resolve(
          jsonResponse({
            documents:
              created.length === 0
                ? []
                : serverPaths.map((path) => ({
                    id: `id-${path}`,
                    path,
                    updatedAt: new Date().toISOString(),
                    kind: 'spatial',
                  })),
          }),
        )
      }
      return Promise.resolve(jsonResponse({ names: {} }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)
    // The list starts empty, so the first create goes through the empty state.
    fireEvent.click(await screen.findByRole('button', { name: 'Create a canvas' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already exists')

    // The failed create re-reads the list, which now shows the colliding
    // canvas — the page leaves the onboarding state and mounts the panel,
    // whose own create button must not repeat the losing path.
    await screen.findByText('untitled')
    await pickNewDocumentKind('spatial')

    await waitFor(() => expect(created).toEqual(['untitled', 'untitled-2']))
    // The point of this test is the PATH the retry picks, not where the user
    // ends up — but both creates open what they made now, so the onboarding
    // one having fired first is why this asserts on the second.
    await waitFor(() => expect(onOpenDocument).toHaveBeenLastCalledWith('ws-a', 'untitled-2'))
  })

  it('the delete dialog names the kind: note for markdown, canvas for spatial', async () => {
    // Hardcoding "canvas" back into this page's dialog must go red here —
    // the local page has the same pin, and the daemon page is not exempt.
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [
          {
            path: 'meeting-notes',
            displayName: 'Meeting notes',
            updatedAt: '2026-08-01T00:00:00Z',
            kind: 'markdown',
          },
          {
            path: 'trip-plan',
            displayName: 'Trip plan',
            updatedAt: '2026-08-02T00:00:00Z',
            kind: 'spatial',
          },
        ],
      },
    })
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />, {
      container: document.body,
    })

    await selectCard('Meeting notes')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    let dialog = await screen.findByRole('alertdialog')
    // A daemon delete is recoverable — document-store.ts routes it through
    // the index's evacuate-first path — so the dialog names the Trash. What
    // it still warns about is the half that really is destroyed.
    expect(
      within(dialog).getByText(DESTRUCTIVE_COPY['delete-document-daemon']('note')),
    ).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    await selectCard('Trip plan')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText(DESTRUCTIVE_COPY['delete-document-daemon']('canvas')),
    ).toBeTruthy()
  })

  // State that NAMES A DOCUMENT must not outlive the workspace it names.
  // `pendingDelete` holds a path, and `handleConfirmDelete` reads
  // `selectedWorkspace` at CONFIRM time rather than at open time — so a
  // switch with the dialog still open addresses the departed workspace's
  // path into the one now on screen. Paths are per-workspace and collide
  // freely, so the DELETE lands on whatever sits at that path here.
  //
  // A modal does not make this unreachable: ADR-0019 makes the switch an
  // in-SPA route change, and browser Back is not blocked by a dialog.
  it('a delete dialog left open across a workspace switch sends no DELETE into the new workspace', async () => {
    const deleted: Array<{ workspaceId: string; path: string }> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        // The SAME path in both, which is the ordinary case rather than a
        // contrived one: every workspace's first document is `untitled`.
        'ws-a': [{ path: 'untitled', displayName: 'Mine', updatedAt: new Date().toISOString() }],
        'ws-b': [
          { path: 'untitled', displayName: 'Someone else', updatedAt: new Date().toISOString() },
        ],
      },
      onDeleteCanvas: (workspaceId, path) => {
        deleted.push({ workspaceId, path })
        return undefined
      },
    })
    const { rerender } = render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} workspace="ws-a" onOpenDocument={vi.fn()} />,
    )

    await selectCard('Mine')
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('alertdialog')

    switchWorkspace(rerender, 'ws-b')
    await waitFor(() => expect(screen.queryByText('Someone else')).toBeTruthy())

    const dialog = screen.queryByRole('alertdialog')
    if (dialog !== null) {
      const confirm = within(dialog).getAllByRole('button', { name: 'Delete' }).at(-1)
      if (confirm) fireEvent.click(confirm)
      await waitFor(() => expect(deleted.length).toBe(0))
    }

    expect(
      deleted,
      'the confirm was addressed at the workspace now on screen using a path from the one that left — `untitled` exists in both, so this deletes a document nobody asked about',
    ).toEqual([])
  })

  it('Delete opens an AlertDialog naming the canvas; Cancel sends no DELETE', async () => {
    const deleted: string[] = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [
          { path: 'alpha', displayName: 'Alpha Board', updatedAt: new Date().toISOString() },
        ],
      },
      namesByWorkspace: { 'ws-a': { documents: { alpha: 'Alpha Board' }, pinned: [] } },
      onDeleteCanvas: (_ws, path) => {
        deleted.push(path)
        return undefined
      },
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />, {
      container: document.body,
    })
    await selectCard('Alpha Board')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/Delete "Alpha Board"\?/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleted).toEqual([])
    // Card title AND the preview heading both say it — still present, twice.
    expect(screen.getAllByText('Alpha Board').length).toBeGreaterThan(0)
    expect(onOpenDocument).not.toHaveBeenCalled()
  })

  it('confirming Delete sends DELETE and the card disappears from the refreshed list', async () => {
    const deleted: string[] = []
    let rows = [
      { path: 'alpha', updatedAt: new Date().toISOString() },
      { path: 'beta', updatedAt: new Date().toISOString() },
    ]
    const routes: Parameters<typeof installFetchMock>[0] = {
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        get 'ws-a'() {
          return rows
        },
      },
      onDeleteCanvas: (_ws, path) => {
        deleted.push(path)
        rows = rows.filter((r) => r.path !== path)
        return undefined
      },
    }
    installFetchMock(routes)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />, {
      container: document.body,
    })
    await selectCard('alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    )

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleted).toEqual(['alpha'])
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull())
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('sends exactly one DELETE for two confirm presses inside a single tick', async () => {
    // Same mechanism as the create tests: React flushes `deleting` before a
    // second click can dispatch on the now-disabled confirm button.
    let resolveDelete: ((res: Response) => void) | undefined
    const deleted: string[] = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
      onDeleteCanvas: (_ws, path) => {
        deleted.push(path)
        return new Promise<Response>((resolve) => {
          resolveDelete = resolve
        })
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />, {
      container: document.body,
    })
    await selectCard('alpha')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const confirm = within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    })
    // No await between them: the disabled flush is the guard under test.
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(deleted).toEqual(['alpha']))
    resolveDelete?.(jsonResponse({ ok: true }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(deleted).toEqual(['alpha'])
  })

  it('a failed Delete shows the sanitized error in the dialog and refreshes after dismissal', async () => {
    let listFetches = 0
    let rows = [{ path: 'alpha', updatedAt: new Date().toISOString() }]
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        get 'ws-a'() {
          listFetches += 1
          return rows
        },
      },
      onDeleteCanvas: () => jsonResponse({ title: 'Canvas not found' }, 404),
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />, {
      container: document.body,
    })
    await selectCard('alpha')
    const fetchesBefore = listFetches

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    // The dialog stays open showing the daemon's sanitized title...
    expect(await within(dialog).findByText('Canvas not found')).toBeTruthy()
    // ...and dismissing it refreshes the list so a stale row (404 = already
    // gone on the daemon) cannot linger.
    rows = []
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(listFetches).toBeGreaterThan(fetchesBefore))
    await waitFor(() => expect(screen.queryByText('alpha')).toBeNull())
  })

  it('has no Storage tab — storage and pairing live on the routed Settings page (design refactor D2)', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />,
        },
      ],
      { initialEntries: ['/'] },
    )
    rtlRender(<RouterProvider router={router} />)
    await screen.findByText('alpha')

    // The top level is the canvas surface only: no tablist at all.
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Storage' })).toBeNull()

    // The operational surfaces (storage, pairing) live on their own route,
    // reached through the App-mounted shell's gear — the page itself owns no
    // settings affordance at all (AppShell ownership rule in DESIGN.md).
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
  })

  it('names the create control in text and hides its glyph from the accessible name', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    const button = screen.getByRole('button', { name: 'New document' })
    expect(button.getAttribute('aria-label')).toBe('New document')
    // WCAG 2.5.3: the visible label is a substring of the accessible name,
    // so "click New" reaches this control by voice. The glyph stays out of
    // the name entirely.
    expect(button.textContent).toContain('New')
    const svg = button.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })

  it('mounts no permanent creation form in the toolbar (ADR-0006)', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    expect(screen.queryByLabelText(/new canvas name/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create canvas' })).toBeNull()
  })

  it('shows a loading skeleton before the first load resolves, never a false empty state', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
      delayCanvases: gate,
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    // While the documents fetch is in flight: structural skeleton, and no
    // premature "No documents" copy.
    expect(await screen.findByRole('status', { name: /loading documents/i })).toBeTruthy()
    expect(screen.queryByText(/no documents/i)).toBeNull()

    release()
    await screen.findByText('alpha')
    expect(screen.queryByRole('status', { name: /loading documents/i })).toBeNull()
  })

  it('a daemon holding no workspaces says so, instead of spinning on the skeleton forever', async () => {
    // The list resolving EMPTY is not the same event as it failing, and it is
    // not "still loading" either: there is simply nothing to select, so the
    // documents fetch that would end the skeleton never runs. Measured before
    // this test existed: `{ skeleton: true, createButtons: 0 }`, permanently.
    const routes = {
      workspaces: [] as Array<{ workspaceId: string }>,
      documentsByWorkspace: {} as Record<string, never[]>,
    }
    installFetchMock(routes)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    expect(await screen.findByText(/no workspaces/i)).toBeTruthy()
    expect(screen.queryByRole('status', { name: /loading documents/i })).toBeNull()
    // And no control that cannot work: every create path needs a workspace to
    // create INTO, and there is none.
    expect(screen.queryByRole('button', { name: /create a canvas/i })).toBeNull()
  })

  it('the no-workspaces state re-lists on demand, landing on a workspace that appeared since', async () => {
    // The recovery here is someone else's write — an agent over MCP, the CLI —
    // so the one action the page can honestly offer is to look again.
    const routes = {
      workspaces: [] as Array<{ workspaceId: string }>,
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
    }
    installFetchMock(routes)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText(/no workspaces/i)

    routes.workspaces = [{ workspaceId: 'ws-a' }]
    fireEvent.click(screen.getByRole('button', { name: /check again/i }))

    expect(await screen.findByText('alpha')).toBeTruthy()
  })

  it('a slower earlier retry cannot undo the newer one that found a workspace', async () => {
    // Both retry controls call loadWorkspaces() with its default isStale,
    // which is only ever false — nothing there orders two overlapping manual
    // retries. Pressing "Check again" twice is enough: if the FIRST response
    // lands last it writes its empty list over the second's, and the
    // no-workspaces branch keys on `workspaces.length === 0` alone, so the
    // page flips back to "no workspaces" while a workspace is selected and
    // its documents are on screen.
    const pending: Array<(workspaces: Array<{ workspaceId: string }>) => void> = []
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces') && (!init || init.method === undefined)) {
        return new Promise<Response>((resolve) => {
          pending.push((workspaces) => resolve(jsonResponse({ workspaces })))
        })
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        return Promise.resolve(
          jsonResponse({
            documents: [
              { path: 'alpha', id: 'doc-a', kind: 'spatial', updatedAt: new Date().toISOString() },
            ],
          }),
        )
      }
      return Promise.resolve(jsonResponse({}, 404))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    // The mount load settles empty, putting the page in the no-workspaces state.
    await waitFor(() => expect(pending).toHaveLength(1))
    await act(async () => pending[0]([]))
    await screen.findByText(/no workspaces/i)

    // Two overlapping retries, resolved in reverse order: the LATER one finds
    // ws-a, then the EARLIER one answers with the list as it was.
    fireEvent.click(screen.getByRole('button', { name: /check again/i }))
    await waitFor(() => expect(pending).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: /check again/i }))
    await waitFor(() => expect(pending).toHaveLength(3))

    await act(async () => pending[2]([{ workspaceId: 'ws-a' }]))
    await screen.findByText('alpha')

    await act(async () => pending[1]([]))

    expect(screen.queryByText(/no workspaces/i)).toBeNull()
    expect(screen.getByText('alpha')).toBeTruthy()
  })

  it('a failed workspace list offers a retry rather than a create button with nowhere to create', async () => {
    // The create control this branch renders is a real recovery path when the
    // DOCUMENTS list failed — the POST needs no rows. When the WORKSPACE list
    // is what failed there is no selection behind it, so `handleCreate`
    // returns at its first line and the button does nothing at all.
    let listAttempts = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        listAttempts += 1
        if (listAttempts === 1) return Promise.resolve(jsonResponse({ message: 'boom' }, 500))
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'ws-a' }] }))
      }
      if (url.endsWith('/api/workspaces/ws-a/documents')) {
        return Promise.resolve(
          jsonResponse({
            documents: [
              { path: 'alpha', id: 'doc-a', kind: 'spatial', updatedAt: new Date().toISOString() },
            ],
          }),
        )
      }
      return Promise.resolve(jsonResponse({}, 404))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    expect((await screen.findByRole('alert')).textContent).toBe('Failed to load workspaces.')
    expect(screen.queryByRole('button', { name: /create a canvas/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByText('alpha')).toBeTruthy()
  })

  it('empty workspace shows one clear next action that creates and opens a canvas', async () => {
    const created: Array<[string, string]> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [] },
      onCreateDocument: (workspaceId, path) => created.push([workspaceId, path]),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)

    expect(await screen.findByText('What will you make first?')).toBeTruthy()
    // Mode-honest copy: the daemon page must NOT show local mode's
    // "stays in this browser" promise — documents live in the daemon here.
    expect(screen.getByTestId('empty-state-subtitle').textContent).toBe(
      'Documents live in this workspace, kept by your local daemon.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create a canvas' }))

    // The action creates immediately — no naming step gates it — and opens
    // the result, same as the toolbar's "New canvas" control.
    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('ws-a', 'untitled'))
    expect(created).toEqual([['ws-a', 'untitled']])
  })

  it('keeps the panel when the workspace lists nothing but its trash is not empty', async () => {
    // Deleting the last document just filled the trash; swapping to the
    // onboarding state would hide the one affordance that undoes it — the
    // same rule BrowserIndexPage keeps for the browser keeper.
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [] },
      trashByWorkspace: {
        'ws-a': [
          { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'doomed', deletedAt: 1_700_000 },
        ],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

    expect(await screen.findByTestId('trash-section')).toBeTruthy()
    expect(screen.queryByText('What will you make first?')).toBeNull()
  })

  it('the empty state also offers a markdown note, sending its kind and opening it', async () => {
    // The onboarding moment is where a writing-first user arrives too — an
    // empty state that can only make a canvas turns them away at the door.
    const kinds: Array<string | undefined> = []
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [] },
      onCreateDocument: (_workspaceId, _path, kind) => kinds.push(kind),
    })
    const onOpenDocument = vi.fn()

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={onOpenDocument} />)

    await screen.findByText('What will you make first?')
    fireEvent.click(screen.getByRole('button', { name: 'Create a markdown note' }))

    await waitFor(() => expect(onOpenDocument).toHaveBeenCalledWith('ws-a', 'untitled'))
    expect(kinds).toEqual(['markdown'])
  })

  it('renders the panel as the one document surface, with no view toggle left', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }] },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    expect(screen.getByTestId('workspace-files-panel')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Grid view' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Tree view' })).toBeNull()
  })
})

// "Mark as Switcher" answers "where does the workspace name appear at all?"
// with: not in the shell row — the document browser names it, as its own
// heading. The shell half shipped first, which left the name nowhere a
// sighted reader could see it; this is the other half.
describe('the workspace names the page', () => {
  it('heads the page with the workspace name, and keeps Documents as the list label', async () => {
    installFetchMock({
      workspaces: [{ workspaceId: WS_ULID, segment: 'marketing-team', displayName: 'Marketing' }],
      // Keyed by the SEGMENT, because that is what the page addresses with:
      // `selectedWorkspace` holds `workspaceHandle(...)`, not the id.
      documentsByWorkspace: {
        'marketing-team': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('Marketing')
    // Not merely absent from the h1 — the generic word moves to the region
    // that actually holds the list, so nothing announces the page as
    // "Documents" while the heading names the workspace.
    expect(heading.className).not.toContain('sr-only')
    expect(screen.getByRole('region', { name: 'Documents' })).toBeTruthy()
  })

  it('falls back through the identity layers rather than showing a raw id', async () => {
    // A workspace with a segment and no display name: the middle layer is
    // what a person chose, so it is what they read. workspaceLabel owns this
    // precedence — the page must not re-derive it and skip a layer.
    installFetchMock({
      workspaces: [{ workspaceId: WS_ULID, segment: 'marketing-team' }],
      // Keyed by the SEGMENT, because that is what the page addresses with:
      // `selectedWorkspace` holds `workspaceHandle(...)`, not the id.
      documentsByWorkspace: {
        'marketing-team': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await screen.findByText('alpha')

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('marketing-team')
  })
})
