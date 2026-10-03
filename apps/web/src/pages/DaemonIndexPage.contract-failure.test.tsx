/**
 * The page keeps its own sentence for a workspace list it cannot read, and the
 * record is what says which route and field disagreed.
 */
import { cleanup, render as rtlRender, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { DaemonIndexPage } from './DaemonIndexPage.js'

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter initialEntries={['/']}>{ui}</MemoryRouter>)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('says "Failed to load workspaces." and logs the route and field when the list is not the shape it reads', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(jsonResponse({ workspaces: [{ nope: true }] }))),
  )

  render(<DaemonIndexPage daemonBaseUrl="http://127.0.0.1:3099" onOpenDocument={vi.fn()} />)

  expect((await screen.findByRole('alert')).textContent).toBe('Failed to load workspaces.')
  await expectLoggedFailure('/api/workspaces failed its contract at workspaces.0.workspaceId')
})
