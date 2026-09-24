/**
 * ADR-0046 F1 / ADR-0047: the web app a server-mode keeper serves from its
 * own origin — the sign-in screen, an invitation, a refusal explained, and
 * the signed-in person's workspaces.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerModeApp } from './ServerModeApp.js'

// The editor pages are the daemon's, exercised on their own; here only what
// the server-mode app hands them matters.
const opened: { page: string; props: Record<string, unknown> }[] = []
vi.mock('./DaemonIndexPage.js', () => ({
  DaemonIndexPage: (props: Record<string, unknown>) => {
    opened.push({ page: 'index', props })
    return <p>workspace index</p>
  },
}))
vi.mock('./DaemonDocumentPage.js', () => ({
  DaemonDocumentPage: (props: Record<string, unknown>) => {
    opened.push({ page: 'document', props })
    return <p>document editor</p>
  },
}))

afterEach(() => {
  cleanup()
  opened.length = 0
})

interface Keeper {
  providers?: { id: string; displayName: string }[] | 'none'
  signedIn?: string
  workspaces?: { workspaceId: string; displayName?: string; segment?: string }[] | 'failing'
  signOut?: 'failing'
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
      return new Response(null, { status: keeper.signOut === 'failing' ? 500 : 204 })
    if (url === '/api/workspaces') {
      return keeper.workspaces === 'failing'
        ? Response.json({ error: 'internal' }, { status: 500 })
        : Response.json({ workspaces: keeper.workspaces ?? [] })
    }
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

  it('says the list failed, rather than sending a signed-in person to sign in', async () => {
    renderAt('/', { signedIn: 'Ada', workspaces: 'failing', providers: [corp] })
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not load/i)
    expect(screen.getByText(/signed in as ada/i)).toBeTruthy()
  })

  it('stays put and says so when signing out fails', async () => {
    renderAt('/', { signedIn: 'Ada', providers: [corp], signOut: 'failing' })
    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not sign out/i)
    expect(screen.getByText(/signed in as ada/i)).toBeTruthy()
  })
})

describe('server mode opens a workspace', () => {
  it('links each workspace to its own address', async () => {
    renderAt('/', { signedIn: 'Ada', workspaces: [{ workspaceId: 'ws-1', displayName: 'Plans' }] })
    const link = await screen.findByRole('link', { name: 'Plans' })
    expect(link.getAttribute('href')).toBe('/w/ws-1')
  })

  it('opens the workspace against this origin, with no token and no WebSocket', async () => {
    renderAt('/w/ws-1', { signedIn: 'Ada' })
    await screen.findByText('workspace index')
    const last = opened.at(-1)
    expect(last?.page).toBe('index')
    expect(last?.props).toMatchObject({
      daemonBaseUrl: window.location.origin,
      workspace: 'ws-1',
      serverMode: true,
    })
    expect(last?.props.token).toBeUndefined()
  })

  it('opens a document in the editor, synced the server-mode way', async () => {
    renderAt('/w/ws-1/d/notes/plan', { signedIn: 'Ada' })
    await screen.findByText('document editor')
    expect(opened.at(-1)?.props).toMatchObject({
      daemonBaseUrl: window.location.origin,
      workspaceId: 'ws-1',
      path: 'notes/plan',
      serverMode: true,
    })
  })

  it('sends a browser with no session to sign in first', async () => {
    renderAt('/w/ws-1', { providers: [corp] })
    expect(await screen.findByRole('link', { name: /continue with corp sso/i })).toBeTruthy()
    expect(opened).toEqual([])
  })
})
