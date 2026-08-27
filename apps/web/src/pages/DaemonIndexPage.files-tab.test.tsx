/**
 * Files tab: the workspace document tree
 * reachable from the daemon index page, with a read-only OKF preview.
 */
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickNewDocumentKind } from '../test-utils/new-document-menu.js'
import { DaemonIndexPage } from './DaemonIndexPage.js'

// The page now reads useNavigate (Settings navigation), so every render
// needs a Router ancestor — wrapping once here keeps the existing
// `render(<DaemonIndexPage .../>)` call sites throughout this file unchanged.
function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const OKF_DOC = '---\ntype: note\ntitle: Design\n---\n\n# Palette decisions'

// The tree reads the same rich list the grid does — the /api/v1 one carries
// no display name and no kind, and the tree needs both.
function installFetchMock(
  listResponse: { status: number; body: unknown } = {
    status: 200,
    body: {
      documents: [
        {
          id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          path: 'notes',
          updatedAt: '2026-05-01T12:00:00.000Z',
          kind: 'markdown',
        },
        {
          id: '01ARZ3NDEKTSV4RRFFQ69G5FA0',
          path: 'notes/design',
          updatedAt: '2026-05-01T12:00:00.000Z',
          kind: 'markdown',
        },
      ],
    },
  },
) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.endsWith('/api/workspaces')) {
      return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'default' }] }))
    }
    if (url.endsWith('/api/v1/workspaces/default/documents/01ARZ3NDEKTSV4RRFFQ69G5FA0/okf')) {
      return Promise.resolve(
        jsonResponse({ markdown: OKF_DOC, frontmatter: { type: 'note', title: 'Design' } }),
      )
    }
    if (url.match(/\/api\/workspaces\/[^/]+\/documents$/)) {
      return Promise.resolve(jsonResponse(listResponse.body, listResponse.status))
    }
    return Promise.resolve(jsonResponse({ message: 'not found' }, 404))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DaemonIndexPage tree view', () => {
  it('shows folders as tree branches and nothing else', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )

    await waitFor(() => {
      expect(screen.getByTestId('workspace-files-panel')).not.toBeNull()
    })
    const tree = screen.getByRole('tree')
    // A nested path renders as a branch, not a flat 'notes/design' row.
    expect(within(tree).queryByText('notes/design')).toBeNull()
    expect(within(tree).getByText('notes')).not.toBeNull()
    // `notes/design` is a document, so the tree — which answers WHERE, not
    // what — does not list it. The contents pane does.
    expect(within(tree).queryByText('design')).toBeNull()
  })

  it('lists a folder’s contents in the middle pane and previews from there', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )

    // At the root the middle pane shows the top level only — `notes` is
    // there as a folder, its child is one level down and is not.
    const contents = await screen.findByTestId('folder-contents')
    expect(contents.textContent).toContain('notes')
    expect(contents.textContent).not.toContain('design')

    // Clicking the folder row in the middle pane moves INTO it.
    fireEvent.click(within(contents).getByRole('button', { name: 'Open folder notes' }))
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).toContain('design')
    })

    // The breadcrumb says WHICH folder is open, not merely which are above
    // it: the deepest segment is current and every ancestor is a way back.
    const crumbs = within(screen.getByRole('navigation', { name: 'Folder path' }))
    expect(crumbs.getByRole('button', { name: 'notes' }).getAttribute('aria-current')).toBe('true')
    expect(
      crumbs.getByRole('button', { name: 'Workspace' }).getAttribute('aria-current'),
    ).toBeNull()

    // The breadcrumb walks back out, and the tree drives the middle pane too.
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).not.toContain('design')
    })
    fireEvent.click(
      within(screen.getByRole('tree')).getByRole('button', { name: 'Open folder notes' }),
    )
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).toContain('design')
    })

    // And the preview is filled from a click in the contents pane, not the
    // sidebar. It shows the document itself — jsdom has no worker, so the
    // drawing is a browser test's job; what belongs here is that the pane is
    // now ABOUT the selected document.
    fireEvent.click(
      within(screen.getByTestId('folder-contents')).getByRole('button', { name: /design/ }),
    )
    await waitFor(() => {
      expect(screen.getByTestId('okf-preview').textContent).toContain('notes/design')
    })
  })

  // The two modes are not a width breakpoint and not a subset of each other:
  // one column reaches every document without moving anything, two columns
  // trade that for cards you can actually see.
  it('switches between one and two columns', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    await screen.findByTestId('folder-contents')

    fireEvent.click(screen.getByRole('button', { name: 'One column' }))
    await waitFor(() => {
      expect(screen.queryByTestId('folder-contents')).toBeNull()
    })
    // The document one level down is reachable without navigating into it.
    const tree = screen.getByRole('tree')
    expect(within(tree).getByText('design')).not.toBeNull()
    // And the trail belongs to whatever narrows the view, which here nothing does.
    expect(screen.queryByRole('navigation', { name: 'Folder path' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Two columns' }))
    await screen.findByTestId('folder-contents')
    expect(screen.getByRole('navigation', { name: 'Folder path' })).not.toBeNull()
  })

  // Selecting in one column fills the same preview the cards fill, so the
  // two modes are two ways into one browser rather than two browsers.
  it('previews from the one-column tree too', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    await screen.findByTestId('folder-contents')
    fireEvent.click(screen.getByRole('button', { name: 'One column' }))

    const tree = await screen.findByRole('tree')
    fireEvent.click(within(tree).getByText('design'))
    await waitFor(() => {
      expect(screen.getByTestId('okf-preview').textContent).toContain('notes/design')
    })
  })

  // The three panes are driven left to right, so a preview showing a
  // document the contents pane does not list is the one way they can
  // disagree — and the contents pane has no row to mark, so nothing on
  // screen says which document the preview belongs to.
  it('drops the preview when navigating to another folder', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )

    const contents = await screen.findByTestId('folder-contents')
    fireEvent.click(within(contents).getByRole('button', { name: 'Open folder notes' }))
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).toContain('design')
    })
    fireEvent.click(
      within(screen.getByTestId('folder-contents')).getByRole('button', { name: /design/ }),
    )
    await waitFor(() => {
      expect(screen.getByTestId('okf-preview').textContent).toContain('notes/design')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    await waitFor(() => {
      expect(screen.queryByTestId('okf-preview')).toBeNull()
    })
    expect(screen.getByText(/Select a document/)).not.toBeNull()
  })

  // The move route has existed since #888 with no caller at all. This is it.
  it('renames a document to a new path, and the panes follow it', async () => {
    // The daemon's own semantics, in miniature: a move takes the subtree.
    let docs = [
      { id: 'a', path: 'notes', updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
      { id: 'b', path: 'notes/design', updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
    ]
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'default' }] }))
      }
      if (url.endsWith('/path') && init?.method === 'PUT') {
        const to = JSON.parse(String(init.body)).path as string
        const from = 'notes/design'
        docs = docs.map((d) =>
          d.path === from || d.path.startsWith(`${from}/`)
            ? { ...d, path: `${to}${d.path.slice(from.length)}` }
            : d,
        )
        return Promise.resolve(jsonResponse({ path: to }))
      }
      if (url.match(/\/api\/workspaces\/[^/]+\/documents$/)) {
        return Promise.resolve(jsonResponse({ documents: docs }))
      }
      return Promise.resolve(jsonResponse({ message: 'not found' }, 404))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    const contents = await screen.findByTestId('folder-contents')
    fireEvent.click(within(contents).getByRole('button', { name: 'Open folder notes' }))
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).toContain('design')
    })
    fireEvent.click(
      within(screen.getByTestId('folder-contents')).getByRole('button', { name: /design/ }),
    )
    await screen.findByTestId('okf-preview')

    fireEvent.click(screen.getByRole('button', { name: /Rename/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/^Path/), {
      target: { value: 'archive/design' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    // The selection follows the document, and the panes move with it —
    // otherwise the preview goes blank exactly when someone wants to see
    // that the move landed.
    await waitFor(() => {
      expect(screen.getByTestId('okf-preview').textContent).toContain('archive/design')
    })
    expect(screen.getByRole('navigation', { name: 'Folder path' }).textContent).toContain('archive')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the server’s refusal when the new path collides', async () => {
    const base = installFetchMock()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        return url.endsWith('/path') && init?.method === 'PUT'
          ? Promise.resolve(jsonResponse({ title: 'Path "archive/design/x" already exists' }, 409))
          : base(input)
      }),
    )

    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    const contents = await screen.findByTestId('folder-contents')
    fireEvent.click(within(contents).getByRole('button', { name: 'Open folder notes' }))
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).toContain('design')
    })
    fireEvent.click(
      within(screen.getByTestId('folder-contents')).getByRole('button', { name: /design/ }),
    )
    await screen.findByTestId('okf-preview')

    fireEvent.click(screen.getByRole('button', { name: /Rename/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/^Path/), {
      target: { value: 'archive/design' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    // The server named a path the caller never typed — that is the point of
    // forwarding its words instead of building a sentence around the input.
    const alert = await within(screen.getByRole('dialog')).findByRole('alert')
    expect(alert.textContent).toContain('archive/design/x')
  })

  // Until now the only way to put a document anywhere but the workspace root
  // was MCP or raw HTTP, so the browser showed a hierarchy it could not add
  // to.
  it('creates a document in the folder it is standing in', async () => {
    const created: string[] = []
    // `notes` needs something under it or it is not a folder to stand in.
    let docs = [
      { id: 'a', path: 'notes', updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
      { id: 'b', path: 'notes/design', updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/workspaces')) {
          return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'default' }] }))
        }
        if (url.match(/\/api\/workspaces\/[^/]+\/documents$/) && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { path: string; kind?: string }
          created.push(body.path)
          docs = [
            ...docs,
            {
              id: `id-${body.path}`,
              path: body.path,
              updatedAt: '2026-05-01T12:00:00.000Z',
              kind: 'markdown',
            },
          ]
          return Promise.resolve(jsonResponse({ path: body.path }))
        }
        if (url.match(/\/api\/workspaces\/[^/]+\/documents$/)) {
          return Promise.resolve(jsonResponse({ documents: docs }))
        }
        return Promise.resolve(jsonResponse({ message: 'not found' }, 404))
      }),
    )

    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    const contents = await screen.findByTestId('folder-contents')

    // At the root it lands at the root.
    await pickNewDocumentKind('markdown')
    await waitFor(() => expect(created).toEqual(['untitled']))

    // Inside a folder it lands in that folder — the whole point.
    fireEvent.click(within(contents).getByRole('button', { name: 'Open folder notes' }))
    await pickNewDocumentKind('markdown')
    await waitFor(() => expect(created).toEqual(['untitled', 'notes/untitled']))

    // And it is selected, so the preview says where it went.
    await waitFor(() => {
      expect(screen.getByTestId('okf-preview').textContent).toContain('notes/untitled')
    })
  })

  // The browser keeps its own list, and the page keeps another. An action
  // the page performs on the browser's behalf must reach BOTH, or the
  // deleted document stays on screen with live buttons still bound to a
  // path that no longer exists.
  it('drops a deleted document from the browser, not only from the page', async () => {
    let docs = [
      { id: 'a', path: 'notes', updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
      { id: 'b', path: 'notes/design', updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/workspaces')) {
          return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'default' }] }))
        }
        if (init?.method === 'DELETE') {
          docs = docs.filter((d) => !url.endsWith(encodeURI(d.path)) || d.path !== 'notes/design')
          return Promise.resolve(jsonResponse({ ok: true }))
        }
        if (url.match(/\/api\/workspaces\/[^/]+\/documents$/)) {
          return Promise.resolve(jsonResponse({ documents: docs }))
        }
        return Promise.resolve(jsonResponse({ message: 'not found' }, 404))
      }),
    )

    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    const contents = await screen.findByTestId('folder-contents')
    fireEvent.click(within(contents).getByRole('button', { name: 'Open folder notes' }))
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).toContain('design')
    })
    fireEvent.click(
      within(screen.getByTestId('folder-contents')).getByRole('button', { name: /design/ }),
    )
    await screen.findByTestId('okf-preview')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/, hidden: false }))
    const confirm = screen
      .getAllByRole('button', { name: /Delete/ })
      .find((b) => b.closest('[role="dialog"]') !== null)
    if (confirm !== undefined) fireEvent.click(confirm)

    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).not.toContain('design')
    })
    // And nothing is left selected, so no button is bound to a path that is gone.
    expect(screen.queryByTestId('okf-preview')).toBeNull()
  })

  // The alert must not outlive the failure that caused it: a create that
  // works after one that did not has to clear the message, or the browser
  // says it is broken forever.
  it('clears the create alert once a create succeeds', async () => {
    let failNext = true
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/workspaces')) {
          return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'default' }] }))
        }
        if (url.match(/\/api\/workspaces\/[^/]+\/documents$/) && init?.method === 'POST') {
          if (failNext) {
            failNext = false
            return Promise.resolve(jsonResponse({ title: 'nope' }, 500))
          }
          return Promise.resolve(jsonResponse({ path: 'untitled' }))
        }
        if (url.match(/\/api\/workspaces\/[^/]+\/documents$/)) {
          // One seeded row: an empty workspace shows the onboarding state
          // instead of the panel, and this test needs the panel's buttons.
          return Promise.resolve(
            jsonResponse({
              documents: [
                {
                  id: 'id-seed',
                  path: 'seed',
                  updatedAt: '2026-08-01T00:00:00Z',
                  kind: 'markdown',
                },
              ],
            }),
          )
        }
        return Promise.resolve(jsonResponse({ message: 'not found' }, 404))
      }),
    )

    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    await screen.findByTestId('folder-contents')

    await pickNewDocumentKind('markdown')
    const alert = await screen.findByText(/Could not create/)
    expect(alert.textContent).toContain('markdown')

    await pickNewDocumentKind('markdown')
    await waitFor(() => {
      expect(screen.queryByText(/Could not create/)).toBeNull()
    })
  })

  // Two buttons, two kinds. A mock that discards the kind would pass with
  // both wired to the same one.
  it('creates a canvas from the canvas button, not another markdown note', async () => {
    const kinds: (string | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/workspaces')) {
          return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'default' }] }))
        }
        if (url.match(/\/api\/workspaces\/[^/]+\/documents$/) && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { path: string; kind?: string }
          kinds.push(body.kind)
          return Promise.resolve(jsonResponse({ path: body.path }))
        }
        if (url.match(/\/api\/workspaces\/[^/]+\/documents$/)) {
          return Promise.resolve(
            jsonResponse({
              documents: [
                {
                  id: 'id-seed',
                  path: 'seed',
                  updatedAt: '2026-08-01T00:00:00Z',
                  kind: 'markdown',
                },
              ],
            }),
          )
        }
        return Promise.resolve(jsonResponse({ message: 'not found' }, 404))
      }),
    )

    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    await screen.findByTestId('folder-contents')

    await pickNewDocumentKind('spatial')
    await waitFor(() => expect(kinds).toEqual(['spatial']))
    await pickNewDocumentKind('markdown')
    await waitFor(() => expect(kinds).toEqual(['spatial', 'markdown']))
  })

  // Three conditional prop spreads and three new call sites on the page —
  // glue code, which is where an argument-order slip lives and where nothing
  // else would catch one.
  it('opens and duplicates through the page’s own handlers', async () => {
    const opened: [string, string][] = []
    const posted: string[] = []
    let docs = [
      { id: 'a', path: 'notes', updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
      { id: 'b', path: 'notes/design', updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.endsWith('/api/workspaces')) {
          return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'default' }] }))
        }
        if (url.match(/\/api\/workspaces\/[^/]+\/documents$/) && init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as { path: string }
          posted.push(body.path)
          docs = [
            ...docs,
            {
              id: `id-${body.path}`,
              path: body.path,
              updatedAt: '2026-05-01T12:00:00.000Z',
              kind: 'markdown',
            },
          ]
          return Promise.resolve(jsonResponse({ path: body.path }))
        }
        if (url.match(/\/api\/workspaces\/[^/]+\/documents$/)) {
          return Promise.resolve(jsonResponse({ documents: docs }))
        }
        // Duplicate reads the source's bytes before it creates anything, so
        // a 404 here throws before the POST and the test would report a
        // wiring failure that is really a fixture gap.
        if (url.endsWith('/snapshot')) {
          return Promise.resolve(
            new Response(new Uint8Array([1, 2, 3]), {
              headers: { 'Content-Type': 'application/octet-stream' },
            }),
          )
        }
        if (url.endsWith('/update')) {
          return Promise.resolve(jsonResponse({ ok: true }))
        }
        // Schema-valid, not merely 200: the client parses this one, and an
        // `{ok:true}` here throws inside the duplicate before it ever
        // reaches the list reload — which reads exactly like broken wiring.
        if (url.endsWith('/name')) {
          return Promise.resolve(jsonResponse({ documents: {}, pinned: [] }))
        }
        return Promise.resolve(jsonResponse({ message: 'not found' }, 404))
      }),
    )

    render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        token="secret"
        onOpenDocument={(workspaceId, path) => opened.push([workspaceId, path])}
      />,
    )
    const contents = await screen.findByTestId('folder-contents')
    fireEvent.click(within(contents).getByRole('button', { name: 'Open folder notes' }))
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).toContain('design')
    })
    fireEvent.click(
      within(screen.getByTestId('folder-contents')).getByRole('button', { name: /design/ }),
    )
    await screen.findByTestId('okf-preview')

    // Both arguments, in order: a workspace passed where a path belongs would
    // still be two strings.
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(opened).toEqual([['default', 'notes/design']])

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    await waitFor(() => expect(posted.length).toBe(1))
    // The copy lands beside the original, and the browser shows it without
    // anyone leaving and coming back.
    expect(posted[0]).toMatch(/^notes\/design/)
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).toContain('copy')
    })
  })

  // Searching is what someone does when they do NOT know where a document
  // is, so the results have to come from folders they are not standing in —
  // including ones they have never opened.
  it('finds a document from a folder it is not standing in', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    const contents = await screen.findByTestId('folder-contents')
    // Standing at the root, where `notes/design` is NOT listed.
    expect(contents.textContent).not.toContain('design')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search documents' }), {
      target: { value: 'design' },
    })

    const results = await screen.findByTestId('search-results')
    expect(results.textContent).toContain('notes/design')
    // The folder view is replaced, not shown beside the results.
    expect(screen.queryByTestId('folder-contents')).toBeNull()
    // And the trail is gone, because the results are not confined to a folder.
    expect(screen.queryByRole('navigation', { name: 'Folder path' })).toBeNull()
  })

  it('previews a result, and goes back to the folder when the search is cleared', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    await screen.findByTestId('folder-contents')

    const box = screen.getByRole('searchbox', { name: 'Search documents' })
    fireEvent.change(box, { target: { value: 'design' } })
    const results = await screen.findByTestId('search-results')

    fireEvent.click(within(results).getByRole('button', { name: /design/ }))
    await waitFor(() => {
      expect(screen.getByTestId('okf-preview').textContent).toContain('notes/design')
    })

    fireEvent.change(box, { target: { value: '' } })
    await screen.findByTestId('folder-contents')
    expect(screen.queryByTestId('search-results')).toBeNull()
  })

  // The invariant the three panes rest on: the preview must never show a
  // document the list beside it does not contain. Searching can reach one
  // from another folder, so clearing the query has to put that right.
  it('drops a result from elsewhere when the search is cleared', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    await screen.findByTestId('folder-contents')

    const box = screen.getByRole('searchbox', { name: 'Search documents' })
    fireEvent.change(box, { target: { value: 'design' } })
    const results = await screen.findByTestId('search-results')
    fireEvent.click(within(results).getByRole('button', { name: /design/ }))
    await waitFor(() => {
      expect(screen.getByTestId('okf-preview').textContent).toContain('notes/design')
    })

    // Back at the root, where `notes/design` is not listed.
    fireEvent.change(box, { target: { value: '' } })
    await screen.findByTestId('folder-contents')
    expect(screen.queryByTestId('okf-preview')).toBeNull()
  })

  // ...but a result that lives where you were already standing is not from
  // elsewhere, and dropping it would lose a selection for no reason.
  it('keeps a result that is in the folder already open', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    const contents = await screen.findByTestId('folder-contents')
    fireEvent.click(within(contents).getByRole('button', { name: 'Open folder notes' }))
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).toContain('design')
    })

    const box = screen.getByRole('searchbox', { name: 'Search documents' })
    fireEvent.change(box, { target: { value: 'design' } })
    const results = await screen.findByTestId('search-results')
    fireEvent.click(within(results).getByRole('button', { name: /design/ }))
    await waitFor(() => {
      expect(screen.getByTestId('okf-preview').textContent).toContain('notes/design')
    })

    fireEvent.change(box, { target: { value: '' } })
    await screen.findByTestId('folder-contents')
    expect(screen.getByTestId('okf-preview').textContent).toContain('notes/design')
  })

  it('says nothing matches rather than showing an empty pane', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )
    await screen.findByTestId('folder-contents')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search documents' }), {
      target: { value: 'zzzz' },
    })
    expect((await screen.findByTestId('search-results')).textContent).toContain('Nothing matches')
  })

  // Was `treats a 404 list as an empty workspace (onboarding, no alert)`, on
  // the premise that "a workspace with no document tree yet is a calm empty
  // workspace the onboarding state can create into". Measured against the real
  // route, that premise is false: an existing workspace holding nothing
  // answers 200 with an empty array, and only an ABSENT one answers 404. So a
  // 404 means gone, and the onboarding state was offering to create into
  // something that is not there — a create the route honours by silently
  // making a DIFFERENT workspace, since it passes `createWorkspace: true`.
  //
  // This fixture is the disagreeing case specifically: the workspace list
  // still reports `default` while its documents 404. There is nothing to move
  // to, and re-selecting `default` would come straight back here forever, so
  // the page reports the failure rather than spinning or pretending.
  it('reports the failure when the list still names a workspace whose documents 404', async () => {
    installFetchMock({ status: 404, body: { error: 'Workspace not found: "default".' } })
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Failed to load documents for this workspace.')
    expect(screen.queryByText('What will you make first?')).toBeNull()
  })

  it('still shows the failure alert when the list fails for a non-404 reason', async () => {
    installFetchMock({ status: 500, body: { error: 'boom' } })
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Failed to load documents for this workspace.')
  })
})
