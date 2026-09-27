/**
 * A workspace the daemon LISTS while its routes answer 404 — one deleted by
 * another client while a tab holds its address, or a registry row with no
 * record behind it. The page resolves the address, the documents 404, and it
 * moves to another workspace; the address must then settle on that one rather
 * than resolve back to the refused one.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { App } from './App.js'
import type { ProviderState } from './lib/provider.js'
import './pages/DaemonIndexPage.js'

vi.mock('./hooks/useDaemonConnection.js', () => ({
  useDaemonConnection: () => ({ status: 'none' }),
}))
vi.mock('./components/status/NotFoundPage.js', () => ({
  NotFoundPage: () => <div data-testid="not-found-page" />,
}))
vi.mock('./pages/PairConsentPage.js', () => ({
  PairConsentPage: () => <div data-testid="pair-consent-page" />,
}))
vi.mock('./pages/SettingsPage.js', () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}))
vi.mock('./pages/BrowserDocumentPage.js', () => ({
  BrowserDocumentPage: () => <div data-testid="browser-document-page" />,
}))
vi.mock('./pages/BrowserIndexPage.js', () => ({
  BrowserIndexPage: () => <div data-testid="browser-index-page" />,
}))
vi.mock('./pages/ReplicaReadPage.js', () => ({
  ReplicaReadPage: () => <div data-testid="replica-read-page" />,
}))
vi.mock('./pages/DaemonDocumentPage.js', () => ({
  DaemonDocumentPage: () => <div data-testid="daemon-document-page" />,
}))

const DAEMON_STATE: ProviderState = { kind: 'daemon', daemonBaseUrl: 'http://127.0.0.1:3099' }
const GONE_ID = '01M3H9HEHZJE9K5MA1K2BNG644'
const LIVE_ID = '01M3HS5Q8P7XXVNNMYGMCPFA5B'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function installDaemon(listed: readonly string[]): { requests: string[] } {
  const requests: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/api/workspaces')) {
        return Promise.resolve(
          json({ workspaces: listed.map((workspaceId) => ({ workspaceId, documentCount: 0 })) }),
        )
      }
      if (url.endsWith('/api/fonts')) return Promise.resolve(json({ fonts: [] }))
      if (url.includes(GONE_ID)) {
        return Promise.resolve(
          json(
            {
              error: 'workspace_not_found',
              message: `Workspace not found: "${GONE_ID}". Pass createWorkspace: true on this wb_workspace_edit call.`,
            },
            404,
          ),
        )
      }
      if (url.endsWith('/names')) return Promise.resolve(json({ names: [] }))
      if (url.endsWith('/document-tags')) return Promise.resolve(json({ tags: [] }))
      return Promise.resolve(json({ documents: [] }))
    }),
  )
  return { requests }
}

function mount(router: ReturnType<typeof createMemoryRouter>): void {
  // A loop between two effects is a warning to React, not an error, and it
  // never yields to a timer — so it would run until the worker is out of
  // memory. Turned into a throw, it aborts the render and fails here instead.
  const original = console.error
  const loopGuard = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (String(args[0]).includes('Maximum update depth')) throw new Error('the page never settled')
    original(...args)
  })
  onTestFinished(() => loopGuard.mockRestore())
  render(<RouterProvider router={router} />)
}

function asksFor(requests: readonly string[], workspaceId: string): number {
  return requests.filter((r) => r.endsWith(`/api/workspaces/${workspaceId}/documents`)).length
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('an address naming a listed-but-refused workspace settles on the other one', async () => {
  const { requests } = installDaemon([LIVE_ID, GONE_ID])
  const router = createMemoryRouter(
    [{ path: '*', element: <App providerState={DAEMON_STATE} /> }],
    {
      initialEntries: [`/w/${GONE_ID}`],
    },
  )
  mount(router)

  await screen.findByText('What will you make first?')
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/w/${LIVE_ID}`))
  expect(asksFor(requests, GONE_ID), requests.join('\n')).toBe(1)
  expect(asksFor(requests, LIVE_ID), requests.join('\n')).toBeLessThanOrEqual(2)
})

it('the only workspace, refused, says so and offers a retry rather than tool advice', async () => {
  const { requests } = installDaemon([GONE_ID])
  const router = createMemoryRouter(
    [{ path: '*', element: <App providerState={DAEMON_STATE} /> }],
    {
      initialEntries: [`/w/${GONE_ID}`],
    },
  )
  mount(router)

  await screen.findByRole('button', { name: 'Try again' })
  expect(asksFor(requests, GONE_ID), requests.join('\n')).toBe(1)
  expect(screen.getByRole('alert').textContent).toBe(
    'This workspace is not on the daemon any more.',
  )
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  expect(document.body.textContent).not.toContain('wb_workspace_edit')
})
