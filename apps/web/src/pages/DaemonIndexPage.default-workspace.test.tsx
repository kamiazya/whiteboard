/**
 * With nothing addressed, the page opens the workspace the daemon calls
 * `default` — the one an agent reaches without being told an id — rather than
 * whichever the list happens to name first, so the browser and the agent start
 * in the same place.
 */
import { cleanup, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { installFakeDaemonFetch } from '../test-utils/fake-daemon-fetch.js'
import { DaemonIndexPage } from './DaemonIndexPage.js'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

const DAEMON_BASE_URL = 'http://127.0.0.1:3099'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('opens the workspace whose segment is `default` even when it is not listed first', async () => {
  installFakeDaemonFetch({
    workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b', segment: 'default' }],
    documentsByWorkspace: {
      'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      default: [{ path: 'beta', updatedAt: new Date().toISOString() }],
    },
  })

  render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

  expect(await screen.findByText('beta')).toBeTruthy()
  expect(screen.queryByText('alpha')).toBeNull()
})

it('opens the first-listed workspace when none is called `default`', async () => {
  installFakeDaemonFetch({
    workspaces: [{ workspaceId: 'ws-a' }, { workspaceId: 'ws-b' }],
    documentsByWorkspace: {
      'ws-a': [{ path: 'alpha', updatedAt: new Date().toISOString() }],
      'ws-b': [{ path: 'beta', updatedAt: new Date().toISOString() }],
    },
  })

  render(<DaemonIndexPage daemonBaseUrl={DAEMON_BASE_URL} onOpenDocument={vi.fn()} />)

  expect(await screen.findByText('alpha')).toBeTruthy()
  expect(screen.queryByText('beta')).toBeNull()
})
