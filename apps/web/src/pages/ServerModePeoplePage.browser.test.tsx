/**
 * ADR-0049's people screens on a server-mode keeper, against a fake keeper
 * that keeps its own state: an administrator manages the server's people, an
 * owner a workspace's, and a refusal is shown in the keeper's words.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerModeApp } from './ServerModeApp.js'

vi.mock('./DaemonIndexPage.js', () => ({ DaemonIndexPage: () => <p>workspace index</p> }))
vi.mock('./DaemonDocumentPage.js', () => ({ DaemonDocumentPage: () => <p>document editor</p> }))

afterEach(cleanup)

interface User {
  userId: string
  displayName: string
  deactivated: boolean
  administrator: boolean
}

const refuse = (error: string, message: string, status: number) =>
  Response.json({ error, message }, { status })
const LINK = { url: 'https://wb.test/invite#token=t-1', expiresAt: '2026-10-03T00:00:00.000Z' }

// `/api/people` and `/api/invitations`, as the keeper answers an administrator.
function tenantRoute(users: User[], me: User, url: string, method: string): Response {
  if (!me.administrator) {
    return refuse('not_an_administrator', 'only an administrator of this server can do that', 403)
  }
  if (url === '/api/invitations') return Response.json(LINK, { status: 201 })
  if (url === '/api/people') return Response.json({ people: users })
  const [, , , id, what] = url.split('/')
  const user = users.find((u) => u.userId === id) as User
  if (what === 'deactivation') user.deactivated = method === 'POST'
  if (what === 'administrator') user.administrator = method === 'PUT'
  return Response.json(
    what === 'deactivation'
      ? { userId: user.userId, deactivated: user.deactivated }
      : { userId: user.userId, administrator: user.administrator },
  )
}

interface Member {
  userId: string
  displayName: string
  role: string
  deactivated: boolean
}

// `/api/workspaces/ws-1/...`, as the keeper answers its members and owners.
function workspaceRoute(members: Member[], me: User, url: string, init?: RequestInit) {
  if (url === '/api/workspaces/ws-1/people') return Response.json({ people: members })
  if (url === '/api/workspaces/ws-1/invitations') {
    const owner = members.some((m) => m.userId === me.userId && m.role === 'owner')
    return owner
      ? Response.json(LINK, { status: 201 })
      : refuse('not_an_owner', 'only an owner of this workspace can change its people', 403)
  }
  const member = members.find((m) => m.userId === url.split('/').at(-1)) as Member
  const { role } = JSON.parse(String(init?.body)) as { role: string }
  if (role === 'member' && members.filter((m) => m.role === 'owner').length === 1) {
    return refuse('last_owner', 'a workspace keeps at least one owner', 409)
  }
  member.role = role
  return Response.json(member)
}

function fakeKeeper(self: 'ada' | 'bob') {
  const users: User[] = [
    { userId: 'u-ada', displayName: 'Ada', deactivated: false, administrator: true },
    { userId: 'u-bob', displayName: 'Bob', deactivated: false, administrator: false },
  ]
  const members: Member[] = [
    { userId: 'u-ada', displayName: 'Ada', role: 'owner', deactivated: false },
    { userId: 'u-bob', displayName: 'Bob', role: 'member', deactivated: false },
  ]
  const me = users.find((u) => u.userId === `u-${self}`) as User
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/auth/session') {
      return Response.json({
        signedIn: true,
        user: { userId: me.userId, displayName: me.displayName, administrator: me.administrator },
      })
    }
    if (url === '/api/workspaces') {
      return Response.json({ workspaces: [{ workspaceId: 'ws-1', displayName: 'Plans' }] })
    }
    if (url.startsWith('/api/people') || url === '/api/invitations') {
      return tenantRoute(users, me, url, init?.method ?? 'GET')
    }
    if (url.startsWith('/api/workspaces/ws-1/')) return workspaceRoute(members, me, url, init)
    return Response.json({ error: 'not_found', message: 'no such route' }, { status: 404 })
  })
}

function renderAt(path: string, fetchFn: ReturnType<typeof fakeKeeper>) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ServerModeApp fetchFn={fetchFn} />
    </MemoryRouter>,
  )
}

describe('the server people screen', () => {
  it('is linked from the workspace list for an administrator only', async () => {
    renderAt('/', fakeKeeper('ada'))
    expect(await screen.findByRole('link', { name: /people on this server/i })).toBeTruthy()
    cleanup()
    renderAt('/', fakeKeeper('bob'))
    await screen.findByText(/signed in as bob/i)
    expect(screen.queryByRole('link', { name: /people on this server/i })).toBeNull()
  })

  it('deactivates a person, and offers no deactivation of oneself', async () => {
    renderAt('/people', fakeKeeper('ada'))
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate Bob' }))
    expect(await screen.findByRole('button', { name: 'Reactivate Bob' })).toBeTruthy()
    expect(screen.getByText(/deactivated/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Deactivate Ada' })).toBeNull()
  })

  it('makes a person an administrator', async () => {
    renderAt('/people', fakeKeeper('ada'))
    fireEvent.click(await screen.findByRole('button', { name: 'Make Bob an administrator' }))
    expect(await screen.findByRole('button', { name: 'Remove Bob as administrator' })).toBeTruthy()
  })

  it('shows an invitation link once it is created', async () => {
    renderAt('/people', fakeKeeper('ada'))
    fireEvent.click(await screen.findByRole('button', { name: /create invitation link/i }))
    const field = await screen.findByLabelText(/can use it once/i)
    expect((field as HTMLInputElement).value).toBe('https://wb.test/invite#token=t-1')
  })

  it("shows the keeper's refusal to someone who is not an administrator", async () => {
    renderAt('/people', fakeKeeper('bob'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/only an administrator/i),
    )
  })
})

describe('the workspace people screen', () => {
  it('is linked from inside the workspace', async () => {
    renderAt('/w/ws-1', fakeKeeper('ada'))
    const link = await screen.findByRole('link', { name: 'People' })
    expect(link.getAttribute('href')).toBe('/people/w/ws-1')
  })

  it('lets an owner make a member an owner', async () => {
    renderAt('/people/w/ws-1', fakeKeeper('ada'))
    fireEvent.click(await screen.findByRole('button', { name: 'Make Bob an owner' }))
    expect(await screen.findByRole('button', { name: 'Make Bob a member' })).toBeTruthy()
  })

  it('says why the last owner cannot step down', async () => {
    renderAt('/people/w/ws-1', fakeKeeper('ada'))
    fireEvent.click(await screen.findByRole('button', { name: 'Make Ada a member' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/at least one owner/i),
    )
  })

  it('shows a member the people and offers them no changes', async () => {
    renderAt('/people/w/ws-1', fakeKeeper('bob'))
    expect(await screen.findByText('Ada')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /make|remove|invitation/i })).toBeNull()
  })
})
