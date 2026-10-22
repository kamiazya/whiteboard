/**
 * ADR-0049 decision 1 over HTTP on server mode: any member reads a
 * workspace's people, only an owner changes them, and the last owner stays.
 * The server-mode middleware is in front, as it is in the app, so the
 * membership gate is the real one. Owners act through a browser sign-in, the
 * only grant a change to a workspace's people accepts.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INVITE_PAGE_PATH,
  inviteTokenOf,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import {
  MAX_PENDING_WORKSPACE_INVITATIONS,
  workspacePeopleRefusalSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import { NAMESPACE_MAX_WORKSPACES } from '@kamiazya/whiteboard-ports'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../../shared/sha256.js'
import { serverModePeople } from '../_test-server-mode-harness.js'
import { ALL_AUTH_SCOPES } from '../security/auth-strategy.js'
import type { InvitationStore } from '../security/invitation-store.js'
import type { MemberProfileStore } from '../security/member-profile-store.js'
import type { AsyncAuthStrategy } from '../security/oauth-resource-strategy.js'
import { createWorkspacePeopleAdministration } from '../security/people-administration.js'
import { serverModePeopleKeeper } from '../security/people-keepers.js'
import { createServerModeApiAuthMiddleware } from '../security/server-mode-middleware.js'
import { SESSION_COOKIE, type SignInSessionStore } from '../security/sign-in-session-store.js'
import { createIsolatedDb, fillNamespace } from '../store/db/test-helpers.js'
import { upsertWorkspaceRow } from '../store/db/upsert-workspace.js'
import { endSyncStreamsOf } from '../sync-streams.js'
import { createWorkspacePeopleRouter } from './workspace-people.js'

vi.mock('../sync-streams.js', () => ({ endSyncStreamsOf: vi.fn() }))

const AUTHENTICATOR = 'oidc:https://idp.test'

const ORIGIN = 'https://wb.test'

// "Bearer <sub>": a verified bearer naming that subject, carrying every scope;
// "Bearer <sub> <scope>…": one carrying only those.
const strategy: AsyncAuthStrategy = {
  async authorize({ authorizationHeader }) {
    const [sub = '', ...scoped] = (authorizationHeader ?? '').replace(/^Bearer /, '').split(' ')
    const scopes =
      scoped.length === 0 ? ALL_AUTH_SCOPES : ALL_AUTH_SCOPES.filter((s) => scoped.includes(s))
    return {
      ok: true,
      context: { kind: 'oauth-resource-server', subject: sub, scopes },
      person: { authenticator: AUTHENTICATOR, subject: sub },
    }
  },
}

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let invitations: InvitationStore
let sessions: SignInSessionStore
let app: Hono
let staleApp: Hono
let roles: ReturnType<typeof serverModePeople>['people']['roles']
const ids: Record<string, string> = {}
const handles: Record<string, string> = {}
const sessionOf: Record<string, string> = {}

// `as` signed in at this host, the way the web app's people screen calls.
function signedIn(as: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${sessionOf[as] ?? ''}`, origin: ORIGIN }
}

async function call(as: string, method: string, path: string, body?: object) {
  return callWith(signedIn(as), method, path, body)
}

async function callWith(
  credential: Record<string, string>,
  method: string,
  path: string,
  body?: object,
) {
  const res = await app.request(`/api/workspaces/ws-1${path}`, {
    method,
    headers: { ...credential, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-workspace-people-'))
  handle = await createIsolatedDb({ dataDir: root })
  const stores = serverModePeople(handle.db, root)
  members = stores.members
  roles = stores.people.roles
  invitations = stores.people.invitations
  sessions = stores.sessions
  for (const name of ['ada', 'bob', 'eve']) {
    const binding = { authenticator: AUTHENTICATOR, subject: name }
    const user = await members.ensureProfile({ binding, displayName: name })
    ids[name] = user.id
    handles[name] = user.handle
    sessionOf[name] = await sessions.create(binding, Date.now(), 60_000, Date.now())
  }
  await members.addMember('ws-1', ids.ada as string)
  await members.addMember('ws-1', ids.bob as string)

  const keeper = serverModePeopleKeeper({ members, invitations, origin: ORIGIN })
  const mount = (k: typeof keeper) => {
    const mounted = new Hono()
    mounted.use(
      '/api/*',
      createServerModeApiAuthMiddleware(strategy, { ...stores.people, origin: ORIGIN }),
    )
    mounted.route(
      '/',
      createWorkspacePeopleRouter({
        people: createWorkspacePeopleAdministration({ members, roles }),
        roles,
        keeper: k,
      }),
    )
    return mounted
  }
  app = mount(keeper)
  // A keeper whose ownership answer was read before the owner was demoted:
  // what a request authorized just ahead of a demotion sees.
  staleApp = mount({ ...keeper, mayChange: async () => null })
})

afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('workspace people', () => {
  // ADR-0042: a stream the removed person already holds would otherwise keep
  // delivering the workspace. Only a removal that happened ends them.
  it('ends the removed person’s open streams, and no one’s for a removal that was refused', async () => {
    vi.mocked(endSyncStreamsOf).mockClear()
    expect((await call('ada', 'DELETE', `/people/${ids.ada}`)).body).toMatchObject({
      error: 'last_owner',
    })
    expect(vi.mocked(endSyncStreamsOf)).not.toHaveBeenCalled()

    expect((await call('ada', 'DELETE', `/people/${ids.bob}`)).status).toBe(200)
    expect(vi.mocked(endSyncStreamsOf)).toHaveBeenCalledExactlyOnceWith(ids.bob, 'ws-1')
  })

  it('lists the people and their roles to any member', async () => {
    const listed = await call('bob', 'GET', '/people')
    expect(listed.status).toBe(200)
    expect(listed.body.canManage).toBe(false)
    expect((await call('ada', 'GET', '/people')).body.canManage).toBe(true)
    // Two memberships made in one millisecond have no defined order.
    const people = listed.body.people as { displayName: string }[]
    expect([...people].sort((a, b) => a.displayName.localeCompare(b.displayName))).toEqual([
      { userId: ids.ada, displayName: 'ada', role: 'owner', deactivated: false },
      { userId: ids.bob, displayName: 'bob', role: 'member', deactivated: false },
    ])
  })

  it('shows nothing to someone who is not a member', async () => {
    expect((await call('eve', 'GET', '/people')).status).toBe(403)
  })

  it('lets an owner add a user, and refuses a member who tries', async () => {
    expect((await call('bob', 'POST', '/people', { userId: ids.eve })).body).toMatchObject({
      error: 'not_an_owner',
    })
    const added = await call('ada', 'POST', '/people', { userId: ids.eve })
    expect(added.status).toBe(201)
    expect(added.body).toMatchObject({ userId: ids.eve, role: 'member' })
    expect(await members.membershipRole('ws-1', ids.eve as string)).toBe('member')
  })

  it('refuses to add a user this keeper does not have', async () => {
    expect(await call('ada', 'POST', '/people', { userId: 'nobody' })).toMatchObject({
      status: 404,
      body: { error: 'unknown_user' },
    })
  })

  it('refuses a malformed body', async () => {
    expect((await call('ada', 'POST', '/people', { user: ids.eve })).status).toBe(400)
    expect((await call('ada', 'PATCH', `/people/${ids.bob}`, { role: 'admin' })).status).toBe(400)
  })

  it('lets an owner make another member an owner, and keeps the last owner', async () => {
    expect(await call('ada', 'PATCH', `/people/${ids.ada}`, { role: 'member' })).toMatchObject({
      status: 409,
      body: { error: 'last_owner' },
    })
    expect(await call('ada', 'PATCH', `/people/${ids.bob}`, { role: 'owner' })).toMatchObject({
      status: 200,
      body: { userId: ids.bob, role: 'owner' },
    })
    expect((await call('ada', 'PATCH', `/people/${ids.ada}`, { role: 'member' })).status).toBe(200)
  })

  it('lets an owner remove a member, and not the last owner', async () => {
    expect((await call('bob', 'DELETE', `/people/${ids.ada}`)).body).toMatchObject({
      error: 'not_an_owner',
    })
    expect((await call('ada', 'DELETE', `/people/${ids.ada}`)).body).toMatchObject({
      error: 'last_owner',
    })
    expect(await call('ada', 'DELETE', `/people/${ids.bob}`)).toEqual({
      status: 200,
      body: { removed: true },
    })
    expect(await call('ada', 'DELETE', `/people/${ids.bob}`)).toMatchObject({
      status: 404,
      body: { error: 'not_a_member' },
    })
  })

  // Leaving would hand the workspace to bob, whose namespace is full: refused
  // with the create's own code, so the ceiling cannot be walked around by
  // handing workspaces to a co-owner.
  it.each([
    ['demote', 'PATCH', { role: 'member' }],
    ['remove', 'DELETE', undefined],
  ] as const)('refuses an owner who would %s themself into a full namespace', async (_, method, body) => {
    await upsertWorkspaceRow(handle.db, 'ws-1', { namespace: handles.ada as string })
    expect((await call('ada', 'PATCH', `/people/${ids.bob}`, { role: 'owner' })).status).toBe(200)
    await fillNamespace(handle.db, handles.bob as string, NAMESPACE_MAX_WORKSPACES)

    const refused = await call('ada', method, `/people/${ids.ada}`, body)

    expect(refused.status).toBe(413)
    expect(workspacePeopleRefusalSchema.parse(refused.body).error).toBe('too_many_workspaces')
    expect(await members.membershipRole('ws-1', ids.ada as string)).toBe('owner')
  })

  // ADR-0049 decision 3: an owner invites into the workspace by a link whose
  // token rides the fragment of the web app's invite page.
  it('refuses a change by an owner demoted after the ownership check', async () => {
    expect(await roles.setRole('ws-1', ids.bob as string, 'owner')).toBe('ok')
    expect(await roles.setRole('ws-1', ids.ada as string, 'member')).toBe('ok')
    const asAda = (method: string, path: string, body?: object) =>
      staleApp.request(`/api/workspaces/ws-1${path}`, {
        method,
        headers: { ...signedIn('ada'), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const refused = async (res: Response) => [
      res.status,
      ((await res.json()) as { error: string }).error,
    ]
    expect(await refused(await asAda('PATCH', `/people/${ids.ada}`, { role: 'owner' }))).toEqual([
      403,
      'not_an_owner',
    ])
    expect(await refused(await asAda('DELETE', `/people/${ids.bob}`))).toEqual([
      403,
      'not_an_owner',
    ])
    expect(await refused(await asAda('POST', '/people', { userId: ids.eve }))).toEqual([
      403,
      'not_an_owner',
    ])
    expect(await members.membershipRole('ws-1', ids.ada as string)).toBe('member')
    expect(await members.membershipRole('ws-1', ids.eve as string)).toBeNull()
    const { invitation } = await invitations.createLink({
      invitedBy: ids.bob as string,
      workspaceId: 'ws-1',
      now: Date.now(),
      ttlMs: 60_000,
    })
    expect(await refused(await asAda('DELETE', `/invitations/${invitation.id}`))).toEqual([
      403,
      'not_an_owner',
    ])
    expect(await invitations.listPending('ws-1', Date.now())).toHaveLength(1)
  })

  it('lets an owner create an invitation link into the workspace, and nobody else', async () => {
    expect((await call('bob', 'POST', '/invitations', {})).body).toMatchObject({
      error: 'not_an_owner',
    })
    const made = await call('ada', 'POST', '/invitations', {})
    expect(made.status).toBe(201)
    const url = new URL(String(made.body.url))
    expect(`${url.origin}${url.pathname}`).toBe(`https://wb.test${INVITE_PAGE_PATH}`)
    const token = inviteTokenOf(url.hash) ?? ''
    expect(await invitations.openLink(token, Date.now())).toMatchObject({
      ok: true,
      invitation: { workspaceId: 'ws-1', invitedBy: ids.ada },
    })
  })

  // A bearer has no browser behind it, so whatever it is scoped it never
  // administers a workspace's people — the bar tenant administration holds.
  describe('an owner acting through a bearer', () => {
    const scopedToWrite = { authorization: 'Bearer ada workspace:write' }

    it.each([
      ['invite by link', 'POST', '/invitations', {}],
      ['add a person', 'POST', '/people', { userId: 'eve' }],
      ['change a role', 'PATCH', '/people/bob', { role: 'owner' }],
      ['remove a person', 'DELETE', '/people/bob', undefined],
    ] as const)('is refused a sign-in to %s', async (_what, method, path, body) => {
      const named = path.replace(/\/(bob)$/, () => `/${ids.bob}`)
      const asked = body !== undefined && 'userId' in body ? { userId: ids.eve } : body
      for (const credential of [scopedToWrite, { authorization: 'Bearer ada' }]) {
        const res = await callWith(credential, method, named, asked)
        expect(res).toEqual({
          status: 403,
          body: { error: 'sign_in_required', message: expect.any(String) },
        })
      }
      expect(await members.membershipRole('ws-1', ids.bob as string)).toBe('member')
      expect(await members.membershipRole('ws-1', ids.eve as string)).toBeNull()
      expect(await invitations.listPending('ws-1', Date.now())).toEqual([])
    })

    it('is refused a sign-in to revoke a pending link', async () => {
      const { invitation } = await invitations.createLink({
        invitedBy: ids.ada as string,
        workspaceId: 'ws-1',
        now: Date.now(),
        ttlMs: 60_000,
      })
      expect(
        await callWith(scopedToWrite, 'DELETE', `/invitations/${invitation.id}`),
      ).toMatchObject({ status: 403, body: { error: 'sign_in_required' } })
      expect(await invitations.listPending('ws-1', Date.now())).toHaveLength(1)
    })

    it('still reads the people, and is told it cannot change them', async () => {
      const listed = await callWith(scopedToWrite, 'GET', '/people')
      expect(listed.status).toBe(200)
      expect(listed.body.canManage).toBe(false)
    })

    it('refuses a member the same way it always did, before asking for a sign-in', async () => {
      expect(
        await callWith({ authorization: 'Bearer bob' }, 'POST', '/people', { userId: ids.eve }),
      ).toMatchObject({ status: 403, body: { error: 'not_an_owner' } })
    })
  })

  // An owner sees who has a link outstanding and can take one back; the
  // token is shown once, at minting, and never again.
  describe('pending invitations', () => {
    it('lists the links still pending to an owner, without the token or its hash', async () => {
      const made = await call('ada', 'POST', '/invitations', {})
      const token = inviteTokenOf(new URL(String(made.body.url)).hash) ?? ''
      const listed = await call('ada', 'GET', '/invitations')
      expect(listed.status).toBe(200)
      const pending = listed.body.invitations as Record<string, unknown>[]
      expect(pending).toHaveLength(1)
      expect(pending[0]).toEqual({
        id: expect.any(String),
        invitedBy: ids.ada,
        createdAt: expect.any(String),
        expiresAt: made.body.expiresAt,
      })
      expect(JSON.stringify(listed.body)).not.toContain(token)
      expect(JSON.stringify(listed.body)).not.toContain(sha256Hex(token))
    })

    it('shows the pending links to an owner alone', async () => {
      expect((await call('bob', 'GET', '/invitations')).body).toMatchObject({
        error: 'not_an_owner',
      })
    })

    it('lets an owner revoke a pending link, which then opens nothing', async () => {
      const made = await call('ada', 'POST', '/invitations', {})
      const token = inviteTokenOf(new URL(String(made.body.url)).hash) ?? ''
      const [pending] = (await call('ada', 'GET', '/invitations')).body.invitations as {
        id: string
      }[]
      const id = pending?.id ?? ''
      expect((await call('bob', 'DELETE', `/invitations/${id}`)).body).toMatchObject({
        error: 'not_an_owner',
      })
      expect(await call('ada', 'DELETE', `/invitations/${id}`)).toEqual({
        status: 200,
        body: { revoked: true },
      })
      expect(await invitations.openLink(token, Date.now())).toEqual({
        ok: false,
        reason: 'unknown',
      })
      expect((await call('ada', 'GET', '/invitations')).body.invitations).toEqual([])
      expect(await call('ada', 'DELETE', `/invitations/${id}`)).toMatchObject({
        status: 404,
        body: { error: 'unknown_invitation' },
      })
    })

    // An owner of one workspace cannot see or revoke another's links by id.
    it('neither lists nor revokes a link into another workspace', async () => {
      await members.addMember('ws-2', ids.eve as string)
      const elsewhere = await invitations.createLink({
        invitedBy: ids.eve as string,
        workspaceId: 'ws-2',
        now: Date.now(),
        ttlMs: 60_000,
      })
      expect((await call('ada', 'GET', '/invitations')).body.invitations).toEqual([])
      expect((await call('ada', 'DELETE', `/invitations/${elsewhere.invitation.id}`)).status).toBe(
        404,
      )
      expect((await invitations.openLink(elsewhere.token, Date.now())).ok).toBe(true)
    })

    it('refuses a link past the pending cap, until one is revoked', async () => {
      for (let i = 0; i < MAX_PENDING_WORKSPACE_INVITATIONS; i++) {
        await invitations.createLink({
          invitedBy: ids.ada as string,
          workspaceId: 'ws-1',
          now: Date.now(),
          ttlMs: 60_000,
        })
      }
      expect(await call('ada', 'POST', '/invitations', {})).toMatchObject({
        status: 409,
        body: { error: 'too_many_invitations' },
      })
      const [first] = (await call('ada', 'GET', '/invitations')).body.invitations as {
        id: string
      }[]
      await call('ada', 'DELETE', `/invitations/${first?.id ?? ''}`)
      expect((await call('ada', 'POST', '/invitations', {})).status).toBe(201)
    })
  })

  it.each([
    ['add a person', 'POST', '/people'],
    ['change a role', 'PATCH', '/people/someone'],
  ])('refuses a body that is not JSON when asked to %s', async (_what, method, path) => {
    const res = await app.request(`/api/workspaces/ws-1${path}`, {
      method,
      headers: { ...signedIn('ada'), 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'invalid_body',
      message: 'the request body is not valid JSON',
    })
  })
})
