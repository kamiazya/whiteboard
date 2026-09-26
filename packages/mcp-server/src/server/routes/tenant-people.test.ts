/**
 * ADR-0049 decisions 1, 2 and 4 over HTTP on server mode: a tenant's
 * administrators see its users, deactivate and reactivate them, appoint and
 * dismiss other administrators, and invite to the tenant. Nobody else can.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAdministratorCheck } from '../security/administrator-check.js'
import { ALL_AUTH_SCOPES } from '../security/auth-strategy.js'
import { createInvitationStore, type InvitationStore } from '../security/invitation-store.js'
import {
  createMemberProfileStore,
  type MemberProfileStore,
} from '../security/member-profile-store.js'
import type { AsyncAuthStrategy } from '../security/oauth-resource-strategy.js'
import { createServerModeApiAuthMiddleware } from '../security/server-mode-middleware.js'
import { createSignInSessionStore } from '../security/sign-in-session-store.js'
import { createTenantAdministratorStore } from '../security/tenant-administrator-store.js'
import { createUserDeactivation } from '../security/user-deactivation.js'
import { createWorkspaceRoles } from '../security/workspace-roles.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createTenantPeopleRouter } from './tenant-people.js'

const AUTHENTICATOR = 'oidc:https://idp.test'

const strategy: AsyncAuthStrategy = {
  async authorize({ authorizationHeader }) {
    const sub = (authorizationHeader ?? '').replace(/^Bearer /, '')
    return {
      ok: true,
      context: { kind: 'oauth-resource-server', subject: sub, scopes: ALL_AUTH_SCOPES },
      person: { authenticator: AUTHENTICATOR, subject: sub },
    }
  },
}

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let invitations: InvitationStore
let app: Hono
const ids: Record<string, string> = {}

async function call(as: string, method: string, path: string, body?: object) {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-tenant-people-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  invitations = createInvitationStore(handle.db)
  for (const name of ['ada', 'bob', 'cy']) {
    const user = await members.ensureProfile({
      binding: { authenticator: AUTHENTICATOR, subject: name },
      displayName: name,
    })
    ids[name] = user.id
  }
  const admins = createTenantAdministratorStore(handle.db)
  await admins.appoint(ids.ada as string, null)
  // cy administers by configuration, not by appointment.
  const administrators = createAdministratorCheck({
    admins,
    members,
    configured: [{ authenticator: AUTHENTICATOR, subject: 'cy' }],
  })
  const people = {
    members,
    sessions: createSignInSessionStore(handle.db),
    roles: createWorkspaceRoles(handle.db),
    invitations,
    administration: {
      check: administrators,
      appointments: admins,
      deactivation: createUserDeactivation(handle.db),
    },
    origin: 'https://wb.test',
  }
  app = new Hono()
  app.use('/api/*', createServerModeApiAuthMiddleware(strategy, people))
  app.route('/', createTenantPeopleRouter(people))
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('tenant people', () => {
  it('lists every user to an administrator, and to nobody else', async () => {
    expect((await call('bob', 'GET', '/people')).body).toMatchObject({
      error: 'not_an_administrator',
    })
    const listed = await call('ada', 'GET', '/people')
    expect(listed.status).toBe(200)
    // Users made in one millisecond have no defined order between them.
    const people = listed.body.people as { displayName: string }[]
    expect([...people].sort((a, b) => a.displayName.localeCompare(b.displayName))).toEqual([
      { userId: ids.ada, displayName: 'ada', deactivated: false, administrator: true },
      { userId: ids.bob, displayName: 'bob', deactivated: false, administrator: false },
      { userId: ids.cy, displayName: 'cy', deactivated: false, administrator: true },
    ])
  })

  it('lets a configured administrator act too', async () => {
    expect((await call('cy', 'GET', '/people')).status).toBe(200)
  })

  it('deactivates and reactivates a user, and refuses deactivating oneself', async () => {
    expect((await call('bob', 'POST', `/people/${ids.ada}/deactivation`)).status).toBe(403)
    expect(await call('ada', 'POST', `/people/${ids.ada}/deactivation`)).toMatchObject({
      status: 409,
      body: { error: 'cannot_deactivate_self' },
    })
    expect(await call('ada', 'POST', `/people/${ids.bob}/deactivation`)).toMatchObject({
      status: 200,
      body: { userId: ids.bob, deactivated: true },
    })
    // Deactivated, bob is refused before any route.
    expect((await call('bob', 'GET', '/people')).body).toMatchObject({ error: 'deactivated' })
    expect(await call('ada', 'DELETE', `/people/${ids.bob}/deactivation`)).toMatchObject({
      status: 200,
      body: { userId: ids.bob, deactivated: false },
    })
  })

  it('appoints and dismisses an administrator, recording who appointed', async () => {
    expect((await call('bob', 'PUT', `/people/${ids.bob}/administrator`)).status).toBe(403)
    expect(await call('ada', 'PUT', `/people/${ids.bob}/administrator`)).toMatchObject({
      status: 200,
      body: { userId: ids.bob, administrator: true },
    })
    expect((await call('bob', 'GET', '/people')).status).toBe(200)
    const [, appointed] = await createTenantAdministratorStore(handle.db).list()
    expect(appointed).toMatchObject({ profileId: ids.bob, appointedBy: ids.ada })
    expect(await call('ada', 'DELETE', `/people/${ids.bob}/administrator`)).toMatchObject({
      status: 200,
      body: { userId: ids.bob, administrator: false },
    })
    expect((await call('bob', 'GET', '/people')).status).toBe(403)
  })

  it('refuses a user this keeper does not have', async () => {
    expect(await call('ada', 'POST', '/people/nobody/deactivation')).toMatchObject({
      status: 404,
      body: { error: 'unknown_user' },
    })
    expect((await call('ada', 'PUT', '/people/nobody/administrator')).status).toBe(404)
  })

  // ADR-0049 decision 3: an administrator's invitation names no workspace and
  // makes a user and nothing more.
  it('lets an administrator invite to the tenant alone', async () => {
    expect((await call('bob', 'POST', '/invitations', {})).status).toBe(403)
    const made = await call('ada', 'POST', '/invitations', {})
    expect(made.status).toBe(201)
    const url = new URL(String(made.body.url))
    const token = new URLSearchParams(url.hash.slice(1)).get('token') ?? ''
    expect(await invitations.openLink(token, Date.now())).toMatchObject({
      ok: true,
      invitation: { workspaceId: null, invitedBy: ids.ada },
    })
  })
})
