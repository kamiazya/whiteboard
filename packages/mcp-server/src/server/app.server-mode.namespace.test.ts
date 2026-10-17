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
