/**
 * ADR-0049 decision 1 over HTTP on server mode: any member reads a
 * workspace's people, only an owner changes them, and the last owner stays.
 * The server-mode middleware is in front, as it is in the app, so the
 * membership gate is the real one.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALL_AUTH_SCOPES } from '../security/auth-strategy.js'
import {
  createMemberProfileStore,
  type MemberProfileStore,
} from '../security/member-profile-store.js'
import type { AsyncAuthStrategy } from '../security/oauth-resource-strategy.js'
import { createServerModeApiAuthMiddleware } from '../security/server-mode-middleware.js'
import { createSignInSessionStore } from '../security/sign-in-session-store.js'
import { createWorkspaceRoles } from '../security/workspace-roles.js'
import { createIsolatedDb } from '../store/db/test-helpers.js'
import { createWorkspacePeopleRouter } from './workspace-people.js'

const AUTHENTICATOR = 'oidc:https://idp.test'

// "Bearer <sub>": a verified bearer naming that subject.
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
let app: Hono
const ids: Record<string, string> = {}

async function call(as: string, method: string, path: string, body?: object) {
  const res = await app.request(`/api/workspaces/ws-1/people${path}`, {
    method,
    headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-workspace-people-'))
  handle = await createIsolatedDb({ dataDir: root })
  members = createMemberProfileStore(handle.db)
  const roles = createWorkspaceRoles(handle.db)
  for (const name of ['ada', 'bob', 'eve']) {
    const user = await members.ensureProfile({
      binding: { authenticator: AUTHENTICATOR, subject: name },
      displayName: name,
    })
    ids[name] = user.id
  }
  await members.addMember('ws-1', ids.ada as string)
  await members.addMember('ws-1', ids.bob as string)

  app = new Hono()
  app.use(
    '/api/*',
    createServerModeApiAuthMiddleware(strategy, {
      members,
      sessions: createSignInSessionStore(handle.db),
      roles,
      origin: 'https://wb.test',
    }),
  )
  app.route('/', createWorkspacePeopleRouter({ members, roles }))
})
afterEach(async () => {
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('workspace people', () => {
  it('lists the people and their roles to any member', async () => {
    const listed = await call('bob', 'GET', '')
    expect(listed.status).toBe(200)
    // Two memberships made in one millisecond have no defined order.
    const people = listed.body.people as { displayName: string }[]
    expect([...people].sort((a, b) => a.displayName.localeCompare(b.displayName))).toEqual([
      { userId: ids.ada, displayName: 'ada', role: 'owner', deactivated: false },
      { userId: ids.bob, displayName: 'bob', role: 'member', deactivated: false },
    ])
  })

  it('shows nothing to someone who is not a member', async () => {
    expect((await call('eve', 'GET', '')).status).toBe(403)
  })

  it('lets an owner add a user, and refuses a member who tries', async () => {
    expect((await call('bob', 'POST', '', { userId: ids.eve })).body).toMatchObject({
      error: 'not_an_owner',
    })
    const added = await call('ada', 'POST', '', { userId: ids.eve })
    expect(added.status).toBe(201)
    expect(added.body).toMatchObject({ userId: ids.eve, role: 'member' })
    expect(await members.membershipRole('ws-1', ids.eve as string)).toBe('member')
  })

  it('refuses to add a user this keeper does not have', async () => {
    expect(await call('ada', 'POST', '', { userId: 'nobody' })).toMatchObject({
      status: 404,
      body: { error: 'unknown_user' },
    })
  })

  it('refuses a malformed body', async () => {
    expect((await call('ada', 'POST', '', { user: ids.eve })).status).toBe(400)
    expect((await call('ada', 'PATCH', `/${ids.bob}`, { role: 'admin' })).status).toBe(400)
  })

  it('lets an owner make another member an owner, and keeps the last owner', async () => {
    expect(await call('ada', 'PATCH', `/${ids.ada}`, { role: 'member' })).toMatchObject({
      status: 409,
      body: { error: 'last_owner' },
    })
    expect(await call('ada', 'PATCH', `/${ids.bob}`, { role: 'owner' })).toMatchObject({
      status: 200,
      body: { userId: ids.bob, role: 'owner' },
    })
    expect((await call('ada', 'PATCH', `/${ids.ada}`, { role: 'member' })).status).toBe(200)
  })

  it('lets an owner remove a member, and not the last owner', async () => {
    expect((await call('bob', 'DELETE', `/${ids.ada}`)).body).toMatchObject({
      error: 'not_an_owner',
    })
    expect((await call('ada', 'DELETE', `/${ids.ada}`)).body).toMatchObject({
      error: 'last_owner',
    })
    expect(await call('ada', 'DELETE', `/${ids.bob}`)).toEqual({
      status: 200,
      body: { removed: true },
    })
    expect(await call('ada', 'DELETE', `/${ids.bob}`)).toMatchObject({
      status: 404,
      body: { error: 'not_a_member' },
    })
  })
})
