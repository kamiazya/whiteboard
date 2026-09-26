/**
 * ADR-0046 decisions 1 and 10, through server mode's whole `/api`: a person is
 * who a session or bearer names, every workspace is members-only from the
 * start, and the person who creates one is its first member.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import type { ServerModeAppOptions } from './app.js'
import { resetSyncStreamsForTests, sseBroadcastWorkspaceUpdate } from './routes/sync-sse.js'
import { createAdministratorCheck } from './security/administrator-check.js'
import { ALL_AUTH_SCOPES } from './security/auth-strategy.js'
import { createInvitationStore } from './security/invitation-store.js'
import {
  createMemberProfileStore,
  type MemberProfileStore,
} from './security/member-profile-store.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import {
  createSignInSessionStore,
  SESSION_COOKIE,
  type SignInSessionStore,
} from './security/sign-in-session-store.js'
import { createTenantAdministratorStore } from './security/tenant-administrator-store.js'
import { createUserDeactivation } from './security/user-deactivation.js'
import { createUserDeletion } from './security/user-deletion.js'
import { createWorkspaceRoles } from './security/workspace-roles.js'
import { accountRetirementFor } from './store/db/account-retirement.js'
import { createIsolatedDb } from './store/db/test-helpers.js'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('./app.js')

const ISSUER = 'oidc:https://idp.test'
const PUBLIC_URL = 'https://example.com'

const bearerNamesItsSubject: AsyncAuthStrategy = {
  async authorize({ authorizationHeader }) {
    const sub = authorizationHeader?.replace(/^Bearer /, '')
    if (!sub) return { ok: false, status: 401, code: 'auth.required', wwwAuthenticate: 'Bearer' }
    return {
      ok: true,
      context: {
        kind: 'oauth-resource-server',
        subject: sub,
        scopes: ALL_AUTH_SCOPES,
      },
      person: { authenticator: ISSUER, subject: sub },
    }
  },
}

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-people-app-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  members = createMemberProfileStore(handle.db)
  sessions = createSignInSessionStore(handle.db)
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps: resolveServerDeps(createContainer()),
    people: {
      members,
      sessions,
      roles: createWorkspaceRoles(handle.db),
      invitations: createInvitationStore(handle.db),
      administration: {
        check: createAdministratorCheck({
          admins: createTenantAdministratorStore(handle.db),
          members: createMemberProfileStore(handle.db),
          configured: [],
        }),
        appointments: createTenantAdministratorStore(handle.db),
        deactivation: createUserDeactivation(handle.db),
        deletion: createUserDeletion(handle.db, accountRetirementFor(tempDir)),
      },
      origin: PUBLIC_URL,
    },
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  app = createApp(options)
})
afterEach(async () => {
  resetSyncStreamsForTests()
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

/** A person signed in at this host just now: a user in the tenant, and a
 *  session recent enough to administer with (ADR-0051). */
async function signedIn(subject: string): Promise<Record<string, string>> {
  const binding = { authenticator: ISSUER, subject }
  await members.ensureProfile({ binding, displayName: subject })
  const token = await sessions.create(binding, Date.now(), 60_000, Date.now())
  return { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL }
}

async function create(headers: Record<string, string>, displayName: string) {
  return app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  })
}

async function listed(headers: Record<string, string>): Promise<string[]> {
  const res = await app.request(`${PUBLIC_URL}/api/workspaces`, { headers })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { workspaces: { displayName?: string }[] }
  return body.workspaces.map((w) => w.displayName ?? '')
}

/** A sync stream opened as `headers`, subscribed to one workspace's record. */
async function followed(headers: Record<string, string>, workspaceId: string) {
  const res = await app.request(`${PUBLIC_URL}/api/sync/stream`, { headers })
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const ready = new TextDecoder().decode((await reader.read()).value)
  const { streamId } = JSON.parse(ready.split('data:')[1] ?? '{}') as { streamId: string }
  const subscribed = await app.request(`${PUBLIC_URL}/api/sync/subscribe`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ streamId, subscribe: [`workspace:${workspaceId}`] }),
  })
  expect(subscribed.status).toBe(200)
  return reader
}

/** What the stream delivers next: an update's text, or `closed`. */
async function next(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const read = await reader.read()
  return read.done ? 'closed' : new TextDecoder().decode(read.value)
}

describe('server mode — a stream open before someone loses access ends with it', () => {
  // ADR-0049 decision 4: deactivation ends a person's sessions at once — the
  // stream they already hold included, not only the requests they make next.
  it('ends a deactivated person’s open sync stream', async () => {
    const ada = await signedIn('ada')
    const bob = await signedIn('bob')
    const adaId = (await members.profileForBinding({ authenticator: ISSUER, subject: 'ada' }))?.id
    const bobId = (await members.profileForBinding({ authenticator: ISSUER, subject: 'bob' }))?.id
    await createTenantAdministratorStore(handle.db).appoint(adaId as string, null)
    const { workspaceId } = (await (await create(bob, 'Plans')).json()) as { workspaceId: string }
    const stream = await followed(bob, workspaceId)

    const res = await app.request(`${PUBLIC_URL}/api/people/${bobId}/deactivation`, {
      method: 'POST',
      headers: ada,
    })
    expect(res.status).toBe(200)
    sseBroadcastWorkspaceUpdate(workspaceId, new Uint8Array([1, 2, 3]))
    expect(await next(stream)).toBe('closed')
  })

  it('ends the open sync stream of someone removed from a workspace', async () => {
    const ada = await signedIn('ada')
    const bob = await signedIn('bob')
    const bobId = (await members.profileForBinding({ authenticator: ISSUER, subject: 'bob' }))?.id
    const { workspaceId } = (await (await create(ada, 'Plans')).json()) as { workspaceId: string }
    const people = `${PUBLIC_URL}/api/workspaces/${workspaceId}/people`
    await app.request(people, {
      method: 'POST',
      headers: { ...ada, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: bobId }),
    })
    const stream = await followed(bob, workspaceId)
    const bystander = await followed(ada, workspaceId)

    expect(
      (await app.request(`${people}/${bobId}`, { method: 'DELETE', headers: ada })).status,
    ).toBe(200)
    sseBroadcastWorkspaceUpdate(workspaceId, new Uint8Array([1, 2, 3]))
    expect(await next(stream)).toBe('closed')
    // Only the person who lost access: the owner still following it is not.
    expect(await next(bystander)).toMatch(/^event: update/)
  })
})

describe('server mode — a workspace belongs to the people in it', () => {
  it('makes the creator its first member, and shows it to nobody else', async () => {
    const ada = await signedIn('ada')
    const eve = await signedIn('eve')
    const res = await create(ada, 'Plans')
    expect(res.status).toBe(201)
    const { workspaceId } = (await res.json()) as { workspaceId: string }

    expect(await listed(ada)).toEqual(['Plans'])
    expect(await listed(eve)).toEqual([])
    const read = (headers: Record<string, string>) =>
      app.request(`${PUBLIC_URL}/api/workspaces/${workspaceId}/documents`, { headers })
    expect((await read(ada)).status).toBe(200)
    expect((await read(eve)).status).toBe(403)
  })

  // ADR-0049 decision 1: the creator is the first OWNER, and an owner lets
  // somebody else in by their user id.
  it('lets the creator, as its owner, add a person who can then open it', async () => {
    const ada = await signedIn('ada')
    const bob = await signedIn('bob')
    const eve = await signedIn('eve')
    const { workspaceId } = (await (await create(ada, 'Plans')).json()) as { workspaceId: string }
    const people = `${PUBLIC_URL}/api/workspaces/${workspaceId}/people`
    const bobId = (await members.profileForBinding({ authenticator: ISSUER, subject: 'bob' }))?.id
    const eveId = (await members.profileForBinding({ authenticator: ISSUER, subject: 'eve' }))?.id

    const listedPeople = await app.request(people, { headers: ada })
    expect(await listedPeople.json()).toMatchObject({
      people: [{ displayName: 'ada', role: 'owner' }],
    })
    const json = { 'content-type': 'application/json' }
    const added = await app.request(people, {
      method: 'POST',
      headers: { ...ada, ...json },
      body: JSON.stringify({ userId: bobId }),
    })
    expect(added.status).toBe(201)
    expect(await listed(bob)).toEqual(['Plans'])

    const byMember = await app.request(people, {
      method: 'POST',
      headers: { ...bob, ...json },
      body: JSON.stringify({ userId: eveId }),
    })
    expect(byMember.status).toBe(403)
    expect(await listed(eve)).toEqual([])
  })

  // ADR-0049 decisions 2 and 4: an administrator sees the tenant's users and
  // deactivates one, who is then refused everywhere; nobody else sees them.
  it('lets an appointed administrator list users and deactivate one', async () => {
    const ada = await signedIn('ada')
    const bob = await signedIn('bob')
    const adaId = (await members.profileForBinding({ authenticator: ISSUER, subject: 'ada' }))?.id
    const bobId = (await members.profileForBinding({ authenticator: ISSUER, subject: 'bob' }))?.id
    await createTenantAdministratorStore(handle.db).appoint(adaId as string, null)

    expect((await app.request(`${PUBLIC_URL}/api/people`, { headers: bob })).status).toBe(403)
    const listed = await app.request(`${PUBLIC_URL}/api/people`, { headers: ada })
    const { people } = (await listed.json()) as {
      people: { displayName: string; administrator: boolean }[]
    }
    // Users made in one millisecond have no defined order between them.
    expect(new Map(people.map((p) => [p.displayName, p.administrator]))).toEqual(
      new Map([
        ['ada', true],
        ['bob', false],
      ]),
    )
    const deactivated = await app.request(`${PUBLIC_URL}/api/people/${bobId}/deactivation`, {
      method: 'POST',
      headers: ada,
    })
    expect(deactivated.status).toBe(200)
    expect((await app.request(`${PUBLIC_URL}/api/workspaces`, { headers: bob })).status).toBe(401)
  })

  // ADR-0051 decision 4: deleting forgets the person, so the same bearer
  // afterwards is a stranger — refused, and not a user again by coming back.
  it('deletes a deactivated person, who comes back as a stranger', async () => {
    const ada = await signedIn('ada')
    await signedIn('bob')
    const adaId = (await members.profileForBinding({ authenticator: ISSUER, subject: 'ada' }))?.id
    const bobId = (await members.profileForBinding({ authenticator: ISSUER, subject: 'bob' }))?.id
    await createTenantAdministratorStore(handle.db).appoint(adaId as string, null)
    const as = (method: string, path: string) =>
      app.request(`${PUBLIC_URL}/api/people/${bobId}${path}`, { method, headers: ada })

    expect((await as('POST', '/deactivation')).status).toBe(200)
    expect((await as('DELETE', '')).status).toBe(200)

    const binding = await handle.rawDb
      .selectFrom('accountBindings')
      .select('accountId')
      .where('subject', '=', 'bob')
      .executeTakeFirst()
    expect(binding).toBeUndefined()
    const res = await create({ authorization: 'Bearer bob' }, 'Back again')
    expect(res.status).toBe(403)
    expect((await members.listUsers()).map((u) => u.id)).toEqual([adaId])
  })

  // Without a user here there is nobody to make the first member, and a
  // workspace with no member would be one nobody can open.
  it('refuses to create a workspace for a bearer that is no user of this tenant', async () => {
    const res = await create({ authorization: 'Bearer stranger' }, 'Orphan')
    expect(res.status).toBe(403)
    expect(await listed({ authorization: 'Bearer stranger' })).toEqual([])
  })
})
