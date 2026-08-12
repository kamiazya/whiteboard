/**
 * Files tab: the OpenCanvas workspace file tree (/api/v1 alias world)
 * reachable from the daemon index page, with a read-only OKF preview.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonIndexPage } from './DaemonIndexPage.js'

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const OKF_DOC = '---\ntype: note\ntitle: Design\n---\n\n# Palette decisions'

function installFetchMock(
  v1ListResponse: { status: number; body: unknown } = {
    status: 200,
    body: {
      canvases: [
        { canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', segment: 'notes', alias: 'notes' },
        {
          canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FA0',
          segment: 'design',
          alias: 'notes/design',
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
    if (url.endsWith('/api/v1/workspaces/default/canvases')) {
      return Promise.resolve(jsonResponse(v1ListResponse.body, v1ListResponse.status))
    }
    if (url.endsWith('/api/v1/workspaces/default/canvases/01ARZ3NDEKTSV4RRFFQ69G5FA0/okf')) {
      return Promise.resolve(
        jsonResponse({ markdown: OKF_DOC, frontmatter: { type: 'note', title: 'Design' } }),
      )
    }
    if (url.match(/\/api\/workspaces\/[^/]+\/canvases$/)) {
      return Promise.resolve(jsonResponse({ canvases: [] }))
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
  it('shows the alias tree and previews a canvas OKF on click', async () => {
    installFetchMock()
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenCanvas={() => {}} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Tree view' }))

    await waitFor(() => {
      expect(screen.getByTestId('workspace-files-panel')).not.toBeNull()
    })
    // Nested alias renders as a tree branch, not a flat 'notes/design' row.
    expect(screen.queryByText('notes/design')).toBeNull()
    const design = await screen.findByText('design')

    fireEvent.click(design)
    await waitFor(() => {
      expect(screen.getByTestId('okf-preview').textContent).toContain('# Palette decisions')
    })
  })

  it('shows a calm no-tree message (not an alert) when the v1 list 404s', async () => {
    installFetchMock({ status: 404, body: { error: 'Workspace not found: "default".' } })
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenCanvas={() => {}} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Tree view' }))

    await screen.findByText('This workspace has no OpenCanvas tree yet.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('still shows the failure alert when the v1 list fails for a non-404 reason', async () => {
    installFetchMock({ status: 500, body: { error: 'boom' } })
    render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenCanvas={() => {}} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Tree view' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Failed to load the workspace file tree.')
  })
})
