/**
 * SettingsPage.test.tsx is at its 905-line file-size ceiling (equal, not
 * under it), so the workspace-id wiring for MembersCard gets its own file
 * rather than growing that one.
 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from './SettingsPage.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderAt(
  path: string,
  daemon: { baseUrl: string; token: string | null } | undefined,
  workspaceId: string | undefined,
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage daemon={daemon} workspaceId={workspaceId} />
    </MemoryRouter>,
  )
}

describe('SettingsPage — Members card wiring', () => {
  it('renders the Members card in Connections when a daemon and a workspace id are both known', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/pairing/grants')) return jsonResponse({ grants: [] })
        if (url.includes('/api/runtime/storage')) {
          return jsonResponse({ totalBytes: 0, fileCount: 0, byCategory: {} })
        }
        if (url.includes('/api/workspaces/ws-1/members')) return jsonResponse({ members: [] })
        if (url.includes('/api/pairing/credentials')) return jsonResponse({ credentials: [] })
        return jsonResponse({}, 404)
      }),
    )

    renderAt('/settings/connections', { baseUrl: 'http://127.0.0.1:9999', token: 'tok' }, 'ws-1')
    const section = screen.getByTestId('settings-section')
    const members = await within(section).findByLabelText('Members')
    expect(within(members).getByText('No one has been added to this workspace yet.')).toBeTruthy()
  })

  it('has no Members card without a known workspace id, even while connected to a daemon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url.includes('/api/pairing/grants')) return jsonResponse({ grants: [] })
        if (url.includes('/api/runtime/storage')) {
          return jsonResponse({ totalBytes: 0, fileCount: 0, byCategory: {} })
        }
        return jsonResponse({}, 404)
      }),
    )

    renderAt('/settings/connections', { baseUrl: 'http://127.0.0.1:9999', token: 'tok' }, undefined)
    const section = screen.getByTestId('settings-section')
    await within(section).findByText('Paired web apps')
    expect(within(section).queryByLabelText('Members')).toBeNull()
  })

  it('has no Members card without a daemon, regardless of workspace id', () => {
    renderAt('/settings/connections', undefined, 'ws-1')
    const section = screen.getByTestId('settings-section')
    expect(within(section).queryByLabelText('Members')).toBeNull()
  })
})
