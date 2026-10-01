/**
 * A workspace the daemon LISTS while its routes answer 404: deleted by another
 * client after the list was taken, or a registry row with no record behind
 * it. The page says what happened in words a person can act on, and never
 * offers to create into it.
 */
import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { DaemonIndexPage } from './DaemonIndexPage.js'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

const DOCUMENTS = /\/api\/(?:v1\/)?workspaces\/[^/]+\/documents$/

function stubDaemon(answers: { documents: () => Response; create?: () => Response }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(jsonResponse({ workspaces: [{ workspaceId: 'default' }] }))
      }
      if (DOCUMENTS.test(url) && init?.method === 'POST' && answers.create) {
        return Promise.resolve(answers.create())
      }
      if (DOCUMENTS.test(url)) return Promise.resolve(answers.documents())
      return Promise.resolve(jsonResponse({ message: 'not found' }, 404))
    }),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
  stubDaemon({ documents: () => jsonResponse({ error: 'Workspace not found: "default".' }, 404) })
  render(
    <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
  )

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('This workspace is not on the daemon any more.')
  expect(screen.queryByText('What will you make first?')).toBeNull()
  // Retrying is the honest action; creating would post into a workspace
  // the daemon does not have.
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Create a canvas' })).toBeNull()
})

// The daemon's 404 reason for a create is written for an MCP caller — it
// tells the reader to pass a tool parameter. A person gets the fact instead.
it('says the workspace is gone when a create answers 404, not the tool advice', async () => {
  const MCP_HINT = 'Pass createWorkspace: true on this wb_workspace_edit call.'
  stubDaemon({
    documents: () => jsonResponse({ documents: [] }),
    create: () =>
      jsonResponse(
        { error: 'workspace_not_found', message: `Workspace not found: "default". ${MCP_HINT}` },
        404,
      ),
  })
  render(
    <DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} token="secret" onOpenDocument={() => {}} />,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Create a canvas' }))

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('This workspace is not on the daemon any more.')
  expect(document.body.textContent).not.toContain('wb_workspace_edit')
})
