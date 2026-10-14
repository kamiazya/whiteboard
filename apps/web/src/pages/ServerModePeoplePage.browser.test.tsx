/**
 * ADR-0049's people screens on a server-mode keeper, against a fake keeper
 * that keeps its own state: an administrator manages the server's people, an
 * owner a workspace's, and a refusal is shown in the keeper's words.
 */
import {
  authReauthenticateUrl,
  authSessionUrl,
  tenantInvitationsApiUrl,
  tenantPeopleApiUrl,
  tenantPersonAdministratorApiUrl,
  tenantPersonApiUrl,
  tenantPersonDeactivationApiUrl,
  workspaceApiUrl,
  workspaceInvitationsApiUrl,
  workspacePeopleApiUrl,
  workspacePersonApiUrl,
  workspacesApiUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DESTRUCTIVE_COPY } from '../lib/destructive-copy.js'
import { ServerModeApp } from './ServerModeApp.js'

vi.mock('./DaemonIndexPage.js', () => ({ DaemonIndexPage: () => <p>workspace index</p> }))
vi.mock('./DaemonDocumentPage.js', () => ({ DaemonDocumentPage: () => <p>document editor</p> }))

afterEach(cleanup)

// The shell's workspace list asks the page's own origin through the global
// fetch, and its answer can land after the test that mounted it has ended, so
// the stub lives for the whole file and answers as whichever keeper is current.
let currentKeeper: ReturnType<typeof fakeKeeper> | undefined
beforeAll(() => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    (currentKeeper ?? fakeKeeper('ada'))(input, init),
  )
})
afterAll(() => {
  vi.unstubAllGlobals()
})

interface User {
  userId: string
  displayName: string
  deactivated: boolean
  administrator: boolean
}

const refuse = (error: string, message: string, status: number) =>
  Response.json({ error, message }, { status })
const LINK = { url: 'https://wb.test/invite#token=t-1', expiresAt: '2026-10-03T00:00:00.000Z' }

// The tenant's people and invitations, as the keeper answers an administrator.
// Routed by the client's own builders, which daemon-client-urls.routes.test.ts
// holds to the server's routes.
function tenantRoute(
  users: User[],
  me: User,
  url: string,
  method: string,
  stale: boolean,
): Response {
  if (!me.administrator) {
    return refuse('not_an_administrator', 'only an administrator of this server can do that', 403)
  }
  // ADR-0051: every action, never the list, needs a recent sign-in.
  if (stale && method !== 'GET') {
    return refuse('reauthentication_required', 'sign in again to confirm it is you', 403)
  }
  if (url === tenantInvitationsApiUrl()) return Response.json(LINK, { status: 201 })
  if (url === tenantPeopleApiUrl()) return Response.json({ people: users })
  const personRoutes = [
    tenantPersonApiUrl,
    tenantPersonDeactivationApiUrl,
    tenantPersonAdministratorApiUrl,
  ]
  const user = users.find((u) => personRoutes.some((route) => route(u.userId) === url)) as User
  if (url === tenantPersonApiUrl(user.userId) && method === 'DELETE') {
    return deleteRoute(users, user)
  }
  const deactivation = url === tenantPersonDeactivationApiUrl(user.userId)
  if (deactivation) user.deactivated = method === 'POST'
  if (url === tenantPersonAdministratorApiUrl(user.userId)) user.administrator = method === 'PUT'
  return Response.json(
    deactivation
      ? { userId: user.userId, deactivated: user.deactivated }
      : { userId: user.userId, administrator: user.administrator },
  )
}

// ADR-0051: only a deactivated person, and never a sole owner (Bob owns ws-2).
function deleteRoute(users: User[], user: User): Response {
  if (!user.deactivated)
    return refuse('not_deactivated', 'deactivate a person before deleting them', 409)
  if (user.userId === 'u-bob' && !users.some((u) => u.userId === 'u-cy')) {
    return Response.json(
      {
        error: 'sole_owner',
        message: 'they are the only owner of these workspaces; appoint another owner first',
        workspaceIds: ['ws-2'],
      },
      { status: 409 },
    )
  }
  users.splice(users.indexOf(user), 1)
  return Response.json({ userId: user.userId, deleted: true })
}

interface Member {
  userId: string
  displayName: string
  role: string
  deactivated: boolean
}

// Workspace ws-1's people, as the keeper answers its members and owners.
function workspaceRoute(members: Member[], me: User, url: string, init?: RequestInit) {
  const owner = members.some((m) => m.userId === me.userId && m.role === 'owner')
  if (url === workspacePeopleApiUrl('ws-1')) {
    return Response.json({ people: members, canManage: owner })
  }
  if (url === workspaceInvitationsApiUrl('ws-1')) {
    return owner
      ? Response.json(LINK, { status: 201 })
      : refuse('not_an_owner', 'only an owner of this workspace can change its people', 403)
  }
  const member = members.find((m) => workspacePersonApiUrl('ws-1', m.userId) === url) as Member
  const { role } = JSON.parse(String(init?.body)) as { role: string }
  if (role === 'member' && members.filter((m) => m.role === 'owner').length === 1) {
    return refuse('last_owner', 'a workspace keeps at least one owner', 409)
  }
  member.role = role
  return Response.json(member)
}

function fakeKeeper(self: 'ada' | 'bob', { stale = false, cy = false } = {}) {
  const users: User[] = [
    { userId: 'u-ada', displayName: 'Ada', deactivated: false, administrator: true },
    { userId: 'u-bob', displayName: 'Bob', deactivated: false, administrator: false },
    ...(cy ? [{ userId: 'u-cy', displayName: 'Cy', deactivated: true, administrator: false }] : []),
  ]
  const members: Member[] = [
    { userId: 'u-ada', displayName: 'Ada', role: 'owner', deactivated: false },
    { userId: 'u-bob', displayName: 'Bob', role: 'member', deactivated: false },
  ]
  const me = users.find((u) => u.userId === `u-${self}`) as User
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // A request through the global fetch arrives absolute; it names the same route.
    const parsed = new URL(String(input), location.origin)
    const url =
      parsed.origin === location.origin ? `${parsed.pathname}${parsed.search}` : String(input)
    if (url === authSessionUrl()) {
      return Response.json({
        signedIn: true,
        user: { userId: me.userId, displayName: me.displayName, administrator: me.administrator },
      })
    }
    if (url === workspacesApiUrl()) {
      return Response.json({ workspaces: [{ workspaceId: 'ws-1', displayName: 'Plans' }] })
    }
    if (url.startsWith(tenantPeopleApiUrl()) || url === tenantInvitationsApiUrl()) {
      return tenantRoute(users, me, url, init?.method ?? 'GET', stale)
    }
    if (url.startsWith(`${workspaceApiUrl('ws-1')}/`)) return workspaceRoute(members, me, url, init)
    return Response.json({ error: 'not_found', message: 'no such route' }, { status: 404 })
  })
}

function renderAt(path: string, fetchFn: ReturnType<typeof fakeKeeper>) {
  currentKeeper = fetchFn
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

  it('deactivates a person, and offers no change to oneself', async () => {
    renderAt('/people', fakeKeeper('ada'))
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate Bob' }))
    expect(await screen.findByRole('button', { name: 'Reactivate Bob' })).toBeTruthy()
    expect(screen.getByText(/deactivated/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Deactivate Ada' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove Ada as administrator' })).toBeNull()
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

  // ADR-0051: deleting is final, so it is offered only for a deactivated
  // person and asks first; the keeper's refusal names the workspaces.
  it('deletes a deactivated person after asking, and offers it to nobody else', async () => {
    renderAt('/people', fakeKeeper('ada', { cy: true }))
    expect(await screen.findByRole('button', { name: 'Delete Cy' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete Bob' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Delete Cy' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain(DESTRUCTIVE_COPY['delete-person']('Cy'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByText('Cy')).toBeNull())
  })

  it('shows the workspaces a sole owner keeps when deletion is refused', async () => {
    renderAt('/people', fakeKeeper('ada'))
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate Bob' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Bob' }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .map((a) => a.textContent)
          .join(' '),
      ).toMatch(/only owner.*ws-2/),
    )
  })

  // ADR-0051: the keeper asks for a recent sign-in, and the page offers one
  // that comes back here, rather than leaving the refusal as a dead end.
  it('offers to sign in again when an action needs a recent sign-in', async () => {
    renderAt('/people', fakeKeeper('ada', { stale: true }))
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate Bob' }))
    const again = await screen.findByRole('link', { name: 'Sign in again' })
    expect(again.getAttribute('href')).toBe(authReauthenticateUrl({ returnTo: '/people' }))
    expect(screen.getByRole('button', { name: 'Deactivate Bob' })).toBeTruthy()
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
      expect(screen.getByRole('status').textContent).toMatch(/at least one owner/i),
    )
  })

  it('shows a member the people and offers them no changes', async () => {
    renderAt('/people/w/ws-1', fakeKeeper('bob'))
    expect(await screen.findByText('Ada')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /make|remove|invitation/i })).toBeNull()
  })
})
