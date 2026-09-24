/**
 * ADR-0046 F1 / ADR-0047: the web app a server-mode keeper serves from its
 * own origin — the sign-in screen, an invitation, a refusal explained, and
 * the signed-in person's workspaces.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerModeApp } from './ServerModeApp.js'

afterEach(cleanup)

interface Keeper {
  providers?: { id: string; displayName: string }[] | 'none'
  signedIn?: string
  workspaces?: { workspaceId: string; displayName?: string; segment?: string }[]
}

// A same-origin keeper answering the handful of routes the app reads.
function keeperFetch(keeper: Keeper) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/auth/providers') {
      return keeper.providers === 'none'
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json({ providers: keeper.providers ?? [] })
    }
    if (url === '/auth/session') {
      return Response.json(
        keeper.signedIn === undefined
          ? { signedIn: false }
          : { signedIn: true, user: { displayName: keeper.signedIn } },
      )
    }
    if (url === '/auth/sign-out' && init?.method === 'POST')
      return new Response(null, { status: 204 })
    if (url === '/api/workspaces') return Response.json({ workspaces: keeper.workspaces ?? [] })
    return Response.json({ error: 'not_found' }, { status: 404 })
  })
}

function renderAt(path: string, keeper: Keeper) {
  const fetchFn = keeperFetch(keeper)
  render(
    <MemoryRouter initialEntries={[path]}>
      <ServerModeApp fetchFn={fetchFn} />
    </MemoryRouter>,
  )
  return fetchFn
}

const corp = { id: 'corp', displayName: 'Corp SSO' }

describe('server mode sign-in', () => {
  it('offers each browser provider, returning to the workspaces after', async () => {
    renderAt('/sign-in', { providers: [corp] })
    const link = await screen.findByRole('link', { name: /continue with corp sso/i })
    expect(link.getAttribute('href')).toBe('/auth/sign-in/corp?return=%2F')
  })

  it('explains a refusal by its reason', async () => {
    renderAt('/sign-in?error=not_invited', { providers: [corp] })
    expect((await screen.findByRole('alert')).textContent).toMatch(/invit/i)
  })

  it('carries an invitation from the link into the sign-in', async () => {
    renderAt('/invite#token=inv-123', { providers: [corp] })
    expect(await screen.findByRole('heading', { name: /invited/i })).toBeTruthy()
    const link = await screen.findByRole('link', { name: /continue with corp sso/i })
    expect(link.getAttribute('href')).toBe('/auth/sign-in/corp?return=%2F&invitation=inv-123')
  })

  it('says so when the server has no provider to sign in with', async () => {
    renderAt('/sign-in', { providers: 'none' })
    expect(await screen.findByText(/no sign-in provider/i)).toBeTruthy()
  })
})

describe('server mode workspaces', () => {
  it("lists the signed-in person's workspaces under their name", async () => {
    renderAt('/', {
      signedIn: 'Ada',
      workspaces: [{ workspaceId: 'ws-1', displayName: 'Plans', segment: 'plans' }],
    })
    expect(await screen.findByText('Plans')).toBeTruthy()
    expect(screen.getByText(/ada/i)).toBeTruthy()
  })

  it('sends a browser with no session to sign in', async () => {
    renderAt('/', { providers: [corp] })
    expect(await screen.findByRole('link', { name: /continue with corp sso/i })).toBeTruthy()
  })

  it('signs out and returns to the sign-in screen', async () => {
    const fetchFn = renderAt('/', { signedIn: 'Ada', providers: [corp] })
    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }))
    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        '/auth/sign-out',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    expect(await screen.findByRole('link', { name: /continue with corp sso/i })).toBeTruthy()
  })
})
