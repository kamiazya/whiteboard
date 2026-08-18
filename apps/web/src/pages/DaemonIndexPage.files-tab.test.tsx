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

    fireEvent.click(await screen.findByRole('button', { name: 'Tree view' }))

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
    fireEvent.click(await screen.findByRole('button', { name: 'Tree view' }))

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

    // And the preview comes from a click in the middle pane, not the tree.
    fireEvent.click(
      screen
        .getByTestId('folder-contents')
        .querySelector<HTMLButtonElement>('button') as HTMLButtonElement,
    )
    await waitFor(() => {
      expect(screen.getByTestId('okf-preview').textContent).toContain('# Palette decisions')
    })
  })

  it('shows a calm no-tree message (not an alert) when the list 404s', async () => {
    installFetchMock({ status: 404, body: { error: 'Workspace not found: "default".' } })
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Tree view' }))

    await screen.findByText('This workspace has no document tree yet.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('still shows the failure alert when the list fails for a non-404 reason', async () => {
    installFetchMock({ status: 500, body: { error: 'boom' } })
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Tree view' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Failed to load the workspace file tree.')
  })
})
