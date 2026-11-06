import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forgetSearchQueries } from '../lib/search-query-memory.js'
import { installFakeDaemonFetch } from '../test-utils/fake-daemon-fetch.js'
import { jsonResponse } from '../test-utils/json-response.js'
import { DaemonIndexPage } from './DaemonIndexPage.js'

// Duplicate from the daemon keeper's list, past the plain happy path that
// DaemonIndexPage.test.tsx covers: the preview pane's second verb, and what
// the list does after a duplicate the daemon refused.

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

function switchWorkspace(rerender: (ui: ReactElement) => void, workspace: string) {
  rerender(
    <MemoryRouter initialEntries={['/']}>
      <DaemonIndexPage
        daemonBaseUrl={DAEMON_BASE_URL}
        workspace={workspace}
        onOpenDocument={vi.fn()}
      />
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  forgetSearchQueries()
  vi.unstubAllGlobals()
})

async function selectCard(name: string) {
  fireEvent.click(await screen.findByText(name))
  await screen.findByTestId('okf-preview')
}

describe('duplicating from the daemon keeper’s list', () => {
  it('duplicates without comments from the preview pane, with the menu’s notice', async () => {
    const asked: unknown[] = []
    let rows = [{ path: 'alpha', name: 'Alpha', updatedAt: new Date().toISOString() }]
    installFakeDaemonFetch({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': () => rows },
      // Answered by the fake's own duplicate route, which confirms
      // `withoutAnnotations` as a current daemon does.
      onDuplicateDocument: (_workspaceId, path, request) => {
        asked.push([path, request])
        const copy = { path: 'alpha-copy', name: 'Alpha (copy)', updatedAt: rows[0]!.updatedAt }
        queueMicrotask(() => {
          rows = [...rows, copy]
        })
      },
    })
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await selectCard('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate without comments' }))

    await waitFor(() => expect(asked).toEqual([['alpha', { withoutAnnotations: true }]]))
    expect(await screen.findByText('Duplicated Alpha without comments')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  /**
   * A refused request does not prove the daemon wrote nothing: the copy can
   * exist while the answer is lost. So the list is re-read after a failure,
   * as the browser keeper's page does, and a copy found there is the
   * outcome — one notice saying so, never that and a failure at once.
   */
  it('reports a copy that landed despite a refused answer only as a copy', async () => {
    let rows = [{ path: 'alpha', name: 'Alpha', updatedAt: new Date().toISOString() }]
    installFakeDaemonFetch({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: { 'ws-a': () => rows },
      namesByWorkspace: { 'ws-a': { documents: { alpha: 'Alpha' }, pinned: [] } },
      onDuplicateDocument: () => {
        rows = [
          ...rows,
          { path: 'alpha-copy', name: 'Alpha (copy)', updatedAt: rows[0]!.updatedAt },
        ]
        return jsonResponse({ title: 'Upstream timed out' }, 500)
      },
    })
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await selectCard('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    await waitFor(() =>
      expect(screen.getAllByTestId('card-title').map((each) => each.textContent)).toEqual([
        'Alpha',
        'Alpha (copy)',
      ]),
    )
    expect(await screen.findByText('Duplicated Alpha')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a refused duplicate that wrote nothing only as a failure', async () => {
    installFakeDaemonFetch({
      workspaces: [{ workspaceId: 'ws-a' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', name: 'Alpha', updatedAt: new Date().toISOString() }],
      },
      onDuplicateDocument: () => jsonResponse({ title: 'Upstream timed out' }, 500),
    })
    render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)
    await selectCard('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/timed out/i)
    expect(screen.queryByText(/^Duplicated /)).toBeNull()
  })

  it('drops a failed duplicate’s alert when the workspace switches', async () => {
    installFakeDaemonFetch({
      workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
      documentsByWorkspace: {
        'ws-a': [{ path: 'alpha', name: 'Alpha', updatedAt: new Date().toISOString() }],
        'ws-b': [{ path: 'beta', name: 'Beta', updatedAt: new Date().toISOString() }],
      },
      onDuplicateDocument: () => jsonResponse({ title: 'Not found' }, 404),
    })
    const { rerender } = render(
      <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} workspace="ws-a" onOpenDocument={vi.fn()} />,
    )
    await selectCard('Alpha')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/not found/i)

    switchWorkspace(rerender, 'ws-b')
    expect(await screen.findByText('Beta')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
