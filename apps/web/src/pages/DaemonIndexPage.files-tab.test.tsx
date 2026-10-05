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
import { type FakeDaemonRoutes, installFakeDaemonFetch } from '../test-utils/fake-daemon-fetch.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { pickNewDocumentKind } from '../test-utils/new-document-menu.js'
import { DaemonIndexPage } from './DaemonIndexPage.js'

// The page now reads useNavigate (Settings navigation), so every render
// needs a Router ancestor — wrapping once here keeps the existing
// `render(<DaemonIndexPage .../>)` call sites throughout this file unchanged.
function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

const OKF_DOC = '---\ntype: note\ntitle: Design\n---\n\n# Palette decisions'

// The tree reads the same rich list the grid does — the /api/v1 one carries
// no display name and no kind, and the tree needs both.
const NOTES_ROWS = [
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
]

/** The shared daemon fake, seeded with one folder; `listResponse` overrides the list wholesale. */
function installFetchMock(
  listResponse?: { status: number; body: unknown },
  overrides: Partial<FakeDaemonRoutes> = {},
) {
  return installFakeDaemonFetch({
    workspaces: [{ workspaceId: 'default' }],
    documentsByWorkspace: { default: NOTES_ROWS },
    okfByDocumentId: {
      '01ARZ3NDEKTSV4RRFFQ69G5FA0': {
        markdown: OKF_DOC,
        body: '# Palette decisions',
        frontmatter: { type: 'note', title: 'Design' },
      },
    },
    ...(listResponse
      ? { onListDocuments: () => jsonResponse(listResponse.body, listResponse.status) }
      : {}),
    ...overrides,
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DaemonIndexPage tree view', () => {
  it('shows folders as tree branches and nothing else', async () => {
    installFetchMock()
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)

    // The tree itself, not the panel around it: the panel now renders while
    // its list is still loading (it holds the layout instead of collapsing
    // to a line of text), so its presence no longer means the documents
    // arrived.
    const tree = await screen.findByRole('tree')
    // A nested path renders as a branch, not a flat 'notes/design' row.
    expect(within(tree).queryByText('notes/design')).toBeNull()
    expect(within(tree).getByText('notes')).not.toBeNull()
    // `notes/design` is a document, so the tree — which answers WHERE, not
    // what — does not list it. The contents pane does.
    expect(within(tree).queryByText('design')).toBeNull()
  })

  it('lists a folder’s contents in the middle pane and previews from there', async () => {
    installFetchMock()
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)

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
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)

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

  // The move route's caller: renaming a document in the files tab.
  it('renames a document to a new path, and the panes follow it', async () => {
    // The daemon's own semantics, in miniature: a move takes the subtree.
    let docs = [
      { id: 'a', path: 'notes', updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
      { id: 'b', path: 'notes/design', updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
    ]
    installFetchMock(undefined, {
      documentsByWorkspace: { default: () => docs },
      onRenameDocumentPath: (_workspaceId, from, to) => {
        docs = docs.map((d) =>
          d.path === from || d.path.startsWith(`${from}/`)
            ? { ...d, path: `${to}${d.path.slice(from.length)}` }
            : d,
        )
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    installFetchMock(undefined, {
      onRenameDocumentPath: () =>
        jsonResponse({ title: 'Path "archive/design/x" already exists' }, 409),
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    installFetchMock(undefined, {
      documentsByWorkspace: { default: () => docs },
      onCreateDocument: (_workspaceId, path) => {
        created.push(path)
        docs = [
          ...docs,
          { id: `id-${path}`, path, updatedAt: '2026-05-01T12:00:00.000Z', kind: 'markdown' },
        ]
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    installFetchMock(undefined, {
      documentsByWorkspace: { default: () => docs },
      onDeleteDocument: (_workspaceId, path) => {
        docs = docs.filter((d) => d.path !== path)
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    // One seeded row: an empty workspace shows the onboarding state instead
    // of the panel, and this test needs the panel's buttons.
    installFetchMock(undefined, {
      documentsByWorkspace: {
        default: [
          {
            documentId: 'id-seed',
            path: 'seed',
            updatedAt: '2026-08-01T00:00:00Z',
            kind: 'markdown',
          },
        ],
      },
      onCreateDocument: () => {
        if (!failNext) return undefined
        failNext = false
        return jsonResponse({ title: 'nope' }, 500)
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    installFetchMock(undefined, {
      documentsByWorkspace: {
        default: [
          {
            documentId: 'id-seed',
            path: 'seed',
            updatedAt: '2026-08-01T00:00:00Z',
            kind: 'markdown',
          },
        ],
      },
      onCreateDocument: (_workspaceId, _path, kind) => {
        kinds.push(kind)
      },
    })

    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    installFetchMock(undefined, {
      documentsByWorkspace: { default: () => docs },
      onDuplicateDocument: (_workspaceId, path) => {
        posted.push(path)
        // What the keeper's copy adds to the listing the page re-reads.
        docs = [
          ...docs,
          {
            id: 'id-copy',
            path: `${path}-copy`,
            updatedAt: '2026-05-01T12:00:00.000Z',
            kind: 'markdown',
          },
        ]
        return jsonResponse({
          document: { documentId: 'id-copy', path: `${path}-copy`, kind: 'markdown' },
        })
      },
    })

    render(
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
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
    // The SOURCE is what the page names; the keeper places the copy beside it,
    // and the browser shows it without anyone leaving and coming back.
    await waitFor(() => expect(posted).toEqual(['notes/design']))
    await waitFor(() => {
      expect(screen.getByTestId('folder-contents').textContent).toContain('copy')
    })
  })

  // Searching is what someone does when they do NOT know where a document
  // is, so the results have to come from folders they are not standing in —
  // including ones they have never opened.
  it('finds a document from a folder it is not standing in', async () => {
    installFetchMock()
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
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
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)
    await screen.findByTestId('folder-contents')

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search documents' }), {
      target: { value: 'zzzz' },
    })
    expect((await screen.findByTestId('search-results')).textContent).toContain('Nothing matches')
  })

  it('still shows the failure alert when the list fails for a non-404 reason', async () => {
    installFetchMock({ status: 500, body: { error: 'boom' } })
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={() => {}} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Failed to load documents for this workspace.')
  })
})
