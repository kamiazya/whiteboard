/**
 * ADR-0053 through server mode's whole `/api`: a workspace segment is unique
 * within its holder's namespace, so a create, a rename and an address each
 * answer only about the CALLER's own namespace — never about which segments
 * somebody else holds. Within one namespace a collision is still a
 * collision, and any owner may meet it (decision 3).
 *
 * Over the real store, not the in-memory double: a bare segment resolves
 * through the daemon's registry, which only the real store fills.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bearerNamesItsSubject,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
} from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { resolveTestServerDeps, testDataLayout } from './routes/_test-helpers.js'
import type { MemberProfileStore } from './security/member-profile-store.js'
import { SESSION_COOKIE, type SignInSessionStore } from './security/sign-in-session-store.js'
import { createWorkspaceRoles } from './security/workspace-roles.js'
import { createIsolatedDb } from './store/db/test-helpers.js'
import { resetSyncStreamsForTests } from './sync-streams.js'

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

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let members: MemberProfileStore
let sessions: SignInSessionStore
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-namespace-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const stores = serverModePeople(handle.db, tempDir)
  members = stores.members
  sessions = stores.sessions
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps: await resolveTestServerDeps(tempDir),
    dataLayout: testDataLayout(tempDir),
    people: stores.people,
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

type Headers = Record<string, string>
const json = { 'content-type': 'application/json' }

async function signedIn(subject: string): Promise<Headers> {
  const binding = { authenticator: ISSUER, subject }
  await members.ensureProfile({ binding, displayName: subject })
  const token = await sessions.create(binding, Date.now(), 60_000, Date.now())
  return { cookie: `${SESSION_COOKIE}=${token}`, origin: PUBLIC_URL }
}

async function userIdOf(subject: string): Promise<string> {
  const profile = await members.profileForBinding({ authenticator: ISSUER, subject })
  if (profile === null) throw new Error(`no user for ${subject}`)
  return profile.id
}

async function create(headers: Headers, displayName: string) {
  const res = await app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: { ...headers, ...json },
    body: JSON.stringify({ displayName }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { workspaceId: string; segment?: string }
}

function rename(headers: Headers, address: string, body: Record<string, string>) {
  return app.request(`${PUBLIC_URL}/api/workspaces/${address}`, {
    method: 'PATCH',
    headers: { ...headers, ...json },
    body: JSON.stringify(body),
  })
}

describe("server mode — a segment in someone else's namespace is invisible", () => {
  it("lets a create take a segment another person's namespace holds, unsuffixed", async () => {
    const ada = await signedIn('ada')
    const eve = await signedIn('eve')
    await create(ada, 'Design')

    expect((await create(eve, 'Design')).segment).toBe('design')
  })

  it("lets a rename take a segment another person's namespace holds", async () => {
    const ada = await signedIn('ada')
    const eve = await signedIn('eve')
    await create(ada, 'Design')
    const { workspaceId } = await create(eve, 'Plans')

    const res = await rename(eve, workspaceId, { segment: 'design' })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ workspaceId, segment: 'design' })
  })

  it("resolves a bare segment in the caller's own namespace", async () => {
    const ada = await signedIn('ada')
    const eve = await signedIn('eve')
    const adas = await create(ada, 'Design')
    const eves = await create(eve, 'Design')

    const asAda = await rename(ada, 'design', { displayName: 'Ada design' })
    const asEve = await rename(eve, 'design', { displayName: 'Eve design' })

    expect(await asAda.json()).toMatchObject({ workspaceId: adas.workspaceId })
    expect(await asEve.json()).toMatchObject({ workspaceId: eves.workspaceId })
    // Past the gate too: a route behind the unknown-workspace refusal finds it.
    const names = await app.request(`${PUBLIC_URL}/api/workspaces/design/names`, { headers: ada })
    expect(names.status).toBe(200)
  })

  it("subscribes a sync stream to a bare segment in the caller's own namespace", async () => {
    const ada = await signedIn('ada')
    const eve = await signedIn('eve')
    await create(ada, 'Design')
    const subscribe = async (headers: Headers) => {
      const res = await app.request(`${PUBLIC_URL}/api/sync/stream`, { headers })
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const ready = new TextDecoder().decode((await reader.read()).value)
      const { streamId } = JSON.parse(ready.split('data:')[1] ?? '{}') as { streamId: string }
      const subscribed = await app.request(`${PUBLIC_URL}/api/sync/subscribe`, {
        method: 'POST',
        headers: { ...headers, ...json },
        body: JSON.stringify({ streamId, subscribe: ['workspace:design'] }),
      })
      await reader.cancel()
      return subscribed.status
    }

    expect(await subscribe(ada)).toBe(200)
    expect(await subscribe(eve)).toBe(403)
  })

  it('refuses a member a bare segment from another namespace, and admits them by id', async () => {
    const ada = await signedIn('ada')
    const bob = await signedIn('bob')
    const { workspaceId } = await create(ada, 'Design')
    await members.addMember(workspaceId, await userIdOf('bob'))

    const bare = await app.request(`${PUBLIC_URL}/api/workspaces/design/documents`, {
      headers: bob,
    })
    const byId = await app.request(`${PUBLIC_URL}/api/workspaces/${workspaceId}/documents`, {
      headers: bob,
    })

    expect(bare.status).toBe(403)
    expect(await bare.json()).toMatchObject({ error: 'not_a_member' })
    expect(byId.status).toBe(200)
  })

  // A listed segment means nothing without the namespace holding it, so each
  // row carries both and the web app addresses it as `<namespace>/<segment>`.
  it('lists each workspace with the namespace that holds its segment', async () => {
    const ada = await signedIn('ada')
    const bob = await signedIn('bob')
    const shared = await create(ada, 'Design')
    const own = await create(bob, 'Notes')
    await members.addMember(shared.workspaceId, await userIdOf('bob'))

    const res = await app.request(`${PUBLIC_URL}/api/workspaces`, { headers: bob })
    const { workspaces } = (await res.json()) as {
      workspaces: { workspaceId: string; namespace?: string; segment?: string }[]
    }

    expect(workspaces).toHaveLength(2)
    expect(workspaces.find((w) => w.workspaceId === shared.workspaceId)).toMatchObject({
      namespace: 'ada',
      segment: 'design',
    })
    expect(workspaces.find((w) => w.workspaceId === own.workspaceId)).toMatchObject({
      namespace: 'bob',
      segment: 'notes',
    })
  })

  it('answers a create and a rename with the namespace the workspace is held in', async () => {
    const ada = await signedIn('ada')
    const created = (await create(ada, 'Design')) as { workspaceId: string; namespace?: string }
    const renamed = await rename(ada, created.workspaceId, { segment: 'plans' })

    expect(created.namespace).toBe('ada')
    expect(await renamed.json()).toMatchObject({ namespace: 'ada', segment: 'plans' })
  })
})

describe('server mode — inside one namespace a segment still collides', () => {
  it("suffixes a create beside the creator's own segment", async () => {
    const ada = await signedIn('ada')
    await create(ada, 'Design')

    expect((await create(ada, 'Design')).segment).toBe('design-2')
  })

  it("refuses a co-owner's rename onto a segment the holder's namespace holds", async () => {
    const ada = await signedIn('ada')
    const bob = await signedIn('bob')
    await create(ada, 'Design')
    const plans = await create(ada, 'Plans')
    const bobId = await userIdOf('bob')
    await members.addMember(plans.workspaceId, bobId)
    await createWorkspaceRoles(handle.db).setRole(plans.workspaceId, bobId, 'owner')
    // Bob holds `design` himself, which does not make Ada's `design` free.
    await create(bob, 'Design')

    const taken = await rename(bob, plans.workspaceId, { segment: 'design' })
    const free = await rename(bob, plans.workspaceId, { segment: 'roadmap' })

    expect(taken.status).toBe(409)
    expect(free.status).toBe(200)
  })
})

// ADR-0053 decision 3 gives a segment change to owners. A plain member is
// refused before the rename runs, so a taken and a free segment answer alike
// and the address others use stays where it is.
describe('server mode — only an owner changes a segment', () => {
  async function planWithMember() {
    const ada = await signedIn('ada')
    const bob = await signedIn('bob')
    await create(ada, 'Design')
    const plans = await create(ada, 'Plans')
    await members.addMember(plans.workspaceId, await userIdOf('bob'))
    return { ada, bob, plans }
  }

  it("refuses a member's segment change, taken or free, leaving it unchanged", async () => {
    const { ada, bob, plans } = await planWithMember()

    const taken = await rename(bob, plans.workspaceId, { segment: 'design' })
    const free = await rename(bob, plans.workspaceId, { segment: 'roadmap' })

    expect(taken.status).toBe(403)
    expect(free.status).toBe(403)
    expect(await taken.json()).toEqual(await free.json())
    const listed = await app.request(`${PUBLIC_URL}/api/workspaces`, { headers: ada })
    const { workspaces } = (await listed.json()) as {
      workspaces: { workspaceId: string; segment?: string }[]
    }
    expect(workspaces.find((w) => w.workspaceId === plans.workspaceId)?.segment).toBe('plans')
  })

  it("refuses a member's segment change carried beside a display name", async () => {
    const { bob, plans } = await planWithMember()

    const res = await rename(bob, plans.workspaceId, { segment: 'roadmap', displayName: 'X' })

    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'not_an_owner' })
  })

  it('lets a member change the display name alone', async () => {
    const { bob, plans } = await planWithMember()

    const res = await rename(bob, plans.workspaceId, { displayName: 'Plans 2027' })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ segment: 'plans', displayName: 'Plans 2027' })
  })
})

// ADR-0053 decision 4's rule, applied when the namespace holder stops being
// an owner: the workspace moves to its oldest remaining owner, so the former
// holder's later creates and renames say nothing about its segment.
describe('server mode — a workspace leaves the namespace of a holder who stops owning it', () => {
  function people(headers: Headers, workspaceId: string, userId: string, init: RequestInit) {
    return app.request(`${PUBLIC_URL}/api/workspaces/${workspaceId}/people/${userId}`, {
      ...init,
      headers: { ...headers, ...json },
    })
  }

  it.each([
    ['removed', { method: 'DELETE' }],
    ['demoted', { method: 'PATCH', body: JSON.stringify({ role: 'member' }) }],
  ] as const)('moves the workspace to the remaining owner when its holder is %s', async (_, init) => {
    const ada = await signedIn('ada')
    const bob = await signedIn('bob')
    const plans = await create(ada, 'Plans')
    const bobId = await userIdOf('bob')
    await members.addMember(plans.workspaceId, bobId)
    await createWorkspaceRoles(handle.db).setRole(plans.workspaceId, bobId, 'owner')

    expect((await people(bob, plans.workspaceId, await userIdOf('ada'), init)).status).toBe(200)
    const renamed = await rename(bob, plans.workspaceId, { segment: 'secret' })

    expect(await renamed.json()).toMatchObject({ namespace: 'bob', segment: 'secret' })
    expect((await create(ada, 'secret')).segment).toBe('secret')
  })

  it('leaves the workspace where it is when an owner who does not hold it is demoted', async () => {
    const ada = await signedIn('ada')
    const plans = await create(ada, 'Plans')
    await signedIn('bob')
    const bobId = await userIdOf('bob')
    await members.addMember(plans.workspaceId, bobId)
    await createWorkspaceRoles(handle.db).setRole(plans.workspaceId, bobId, 'owner')

    const init = { method: 'PATCH', body: JSON.stringify({ role: 'member' }) }
    expect((await people(ada, plans.workspaceId, bobId, init)).status).toBe(200)

    const renamed = await rename(ada, plans.workspaceId, { segment: 'roadmap' })
    expect(await renamed.json()).toMatchObject({ namespace: 'ada', segment: 'roadmap' })
  })

  // The holder is not always the oldest owner: once a workspace has moved,
  // an older owner may still be in it, and demoting somebody else must not
  // hand it to them.
  it('keeps a moved workspace with its holder when another owner is demoted', async () => {
    const ada = await signedIn('ada')
    const bob = await signedIn('bob')
    await signedIn('cy')
    const plans = await create(ada, 'Plans')
    const adaId = await userIdOf('ada')
    const bobId = await userIdOf('bob')
    const cyId = await userIdOf('cy')
    const roles = createWorkspaceRoles(handle.db)
    await members.addMember(plans.workspaceId, bobId)
    await members.addMember(plans.workspaceId, cyId)
    await roles.setRole(plans.workspaceId, bobId, 'owner')
    await roles.setRole(plans.workspaceId, adaId, 'member')
    await roles.setRole(plans.workspaceId, adaId, 'owner')
    await roles.setRole(plans.workspaceId, cyId, 'owner')

    expect(await roles.setRole(plans.workspaceId, cyId, 'member')).toBe('ok')

    const renamed = await rename(bob, plans.workspaceId, { segment: 'roadmap' })
    expect(await renamed.json()).toMatchObject({ namespace: 'bob', segment: 'roadmap' })
  })

  it('leaves the workspace with its holder when the holder is made an owner again', async () => {
    const ada = await signedIn('ada')
    await signedIn('bob')
    const plans = await create(ada, 'Plans')
    const bobId = await userIdOf('bob')
    await members.addMember(plans.workspaceId, bobId)
    const roles = createWorkspaceRoles(handle.db)
    await roles.setRole(plans.workspaceId, bobId, 'owner')

    expect(await roles.setRole(plans.workspaceId, await userIdOf('ada'), 'owner')).toBe('ok')

    const renamed = await rename(ada, plans.workspaceId, { segment: 'roadmap' })
    expect(await renamed.json()).toMatchObject({ namespace: 'ada', segment: 'roadmap' })
  })
})

// ADR-0053 decision 1: whether a handle, a segment or a workspace exists may
// be visible to the tenant's signed-in users, never to a request with no
// session. Every route the app mounts is asked twice with no credential —
// once naming what exists, once naming what does not — and must answer the
// same both times.
describe('server mode — nothing unauthenticated tells what exists from what does not', () => {
  const ABSENT_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

  /** A request for `path` with every parameter and wildcard filled with `value`. */
  function filled(path: string, value: string): string {
    return path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, value).replace(/\*/g, value)
  }

  async function answer(method: string, url: string, body?: unknown) {
    const res = await app.request(url, {
      method,
      headers: { origin: PUBLIC_URL, ...(body === undefined ? {} : json) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: await res.text() }
  }

  it('answers every mounted route the same for an existing and an absent address', async () => {
    const ada = await signedIn('ada')
    const { workspaceId } = await create(ada, 'Design')
    const pairs: Array<[string, string]> = [
      ['design', 'nothing'],
      [workspaceId, ABSENT_ID],
      ['ada', 'nobody'],
    ]
    const routes = [
      ...new Map(
        app.routes
          .filter((r) => r.path.includes(':') || r.path.includes('*'))
          .map((r) => [`${r.method} ${r.path}`, r] as const),
      ).values(),
    ]
    expect(routes.filter((r) => r.path.startsWith('/api/')).length).toBeGreaterThan(20)

    for (const route of routes) {
      const method = route.method === 'ALL' ? 'GET' : route.method
      for (const [existing, absent] of pairs) {
        const real = await answer(method, `${PUBLIC_URL}${filled(route.path, existing)}`)
        const none = await answer(method, `${PUBLIC_URL}${filled(route.path, absent)}`)
        expect(none.status, `${method} ${route.path} with ${existing}`).toBe(real.status)
        expect(none.body.replaceAll(absent, '·'), `${method} ${route.path}`).toBe(
          real.body.replaceAll(existing, '·'),
        )
      }
    }
  })

  it('answers the in-app and opaque web addresses the same whatever they name', async () => {
    const ada = await signedIn('ada')
    const { workspaceId } = await create(ada, 'Design')
    const pairs: Array<[string, string]> = [
      ['/w/ada/design', '/w/nobody/x'],
      ['/w/ada/design', '/w/ada/nothing'],
      [`/w/${workspaceId}`, `/w/${ABSENT_ID}`],
      ['/w/design/d/notes', '/w/nothing/d/notes'],
    ]
    for (const [existing, absent] of pairs) {
      const real = await answer('GET', `${PUBLIC_URL}${existing}`)
      const none = await answer('GET', `${PUBLIC_URL}${absent}`)
      expect(none, existing).toEqual(real)
    }
  })

  it('answers the address-carrying bodies the same', async () => {
    const ada = await signedIn('ada')
    const { workspaceId } = await create(ada, 'Design')
    const bodies: Array<[string, (w: string) => unknown]> = [
      ['/api/sync/subscribe', (w) => ({ streamId: 's', subscribe: [`workspace:${w}`] })],
      [
        '/api/sync/message',
        (w) => ({ streamId: 's', doc: `workspace:${w}`, type: 'client_ready' }),
      ],
      [
        '/mcp',
        (w) => ({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'wb_document_list', arguments: { workspaceId: w } },
        }),
      ],
    ]
    for (const [path, body] of bodies) {
      for (const [existing, absent] of [
        ['design', 'nothing'],
        [workspaceId, ABSENT_ID],
      ] as const) {
        const real = await answer('POST', `${PUBLIC_URL}${path}`, body(existing))
        const none = await answer('POST', `${PUBLIC_URL}${path}`, body(absent))
        expect(none, `${path} with ${existing}`).toEqual(real)
      }
    }
  })
})

// The move above must not plant a segment somebody else chose under the bare
// name its new holder would type: a person who adds an owner and then leaves
// would otherwise put `journal` into that owner's namespace, where their own
// `journal` — by URL or by an agent's `createWorkspace` — reaches it.
describe("server mode — a workspace handed over keeps out of its recipient's bare names", () => {
  function people(headers: Headers, path: string, init: RequestInit) {
    return app.request(`${PUBLIC_URL}/api/workspaces/${path}`, {
      ...init,
      headers: { ...headers, ...json },
    })
  }

  async function plantedJournal(leave: 'DELETE' | 'PATCH') {
    const mallory = await signedIn('mallory')
    await signedIn('bob')
    const journal = await create(mallory, 'Journal')
    const bobId = await userIdOf('bob')
    const malloryId = await userIdOf('mallory')
    const add = { method: 'POST', body: JSON.stringify({ userId: bobId }) }
    expect((await people(mallory, `${journal.workspaceId}/people`, add)).status).toBe(201)
    const promote = { method: 'PATCH', body: JSON.stringify({ role: 'owner' }) }
    const promoted = await people(mallory, `${journal.workspaceId}/people/${bobId}`, promote)
    expect(promoted.status).toBe(200)
    const init =
      leave === 'DELETE'
        ? { method: 'DELETE' }
        : { method: 'PATCH', body: JSON.stringify({ role: 'member' }) }
    const left = await people(mallory, `${journal.workspaceId}/people/${malloryId}`, init)
    expect(left.status).toBe(200)
    return journal.workspaceId
  }

  it.each([
    'DELETE',
    'PATCH',
  ] as const)("answers the recipient's bare segment with nothing after a %s", async (leave) => {
    const workspaceId = await plantedJournal(leave)
    const bob = { authorization: 'Bearer bob' }

    const listed = await app.request(`${PUBLIC_URL}/api/workspaces`, { headers: bob })
    const { workspaces } = (await listed.json()) as {
      workspaces: { workspaceId: string; namespace?: string; segment?: string }[]
    }
    const moved = workspaces.find((w) => w.workspaceId === workspaceId)
    expect(moved?.namespace).toBe('bob')
    expect(moved?.segment).not.toBe('journal')
    const read = (address: string) =>
      app.request(`${PUBLIC_URL}/api/workspaces/${address}/people`, { headers: bob })
    expect((await read(workspaceId)).status).toBe(200)
    const bare = await read('journal')
    const absent = await read('nothing')
    expect(bare.status).toBe(absent.status)
    expect(await bare.text()).toBe((await absent.text()).replace('nothing', 'journal'))
  })

  it("mints the recipient's own workspace for an agent's createWorkspace on that name", async () => {
    const planted = await plantedJournal('PATCH')
    const client = new Client({ name: 'agent-bob', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
      fetch: async (input, init) => {
        const headers = new globalThis.Headers(init?.headers)
        headers.set('Authorization', 'Bearer bob')
        return app.request(input instanceof URL ? input.toString() : String(input), {
          ...init,
          headers,
        })
      },
    })
    await client.connect(transport)
    try {
      const res = (await client.callTool({
        name: 'wb_workspace_edit',
        arguments: {
          workspaceId: 'journal',
          createWorkspace: true,
          ops: [{ op: 'document.create', path: 'diary', kind: 'markdown', markdown: 'private' }],
        },
      })) as {
        isError?: boolean
        content: { text?: string }[]
        structuredContent?: { workspaceId?: string }
      }
      expect(res.isError, res.content[0]?.text).toBeFalsy()
      const minted = res.structuredContent?.workspaceId
      expect(minted).toMatch(/^[0-9A-Z]{26}$/)
      expect(minted).not.toBe(planted)

      const roles = createWorkspaceRoles(handle.db)
      const memberIds = (await roles.list(minted ?? '')).map((m) => m.profile.id)
      expect(memberIds).toEqual([await userIdOf('bob')])
      expect(memberIds).not.toContain(await userIdOf('mallory'))
    } finally {
      await transport.close()
    }
  })
})
