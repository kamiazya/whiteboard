/**
 * Every HTTP route only server mode mounts, requested with what its own input
 * schema admits — and with what it does not.
 *
 * `app.routes.fuzz.property.test.ts` fuzzes the local daemon's composition,
 * which mounts none of these: a workspace's people, the tenant's people and
 * invitations, and the `/auth` sign-in routes. They are the handlers that
 * deactivate and delete users, appoint administrators and open sessions, and
 * they answer anything but a refusal only to a signed-in person in a tenant
 * with an OIDC provider — so this lane seeds one, and signs people in by the
 * session cookie a browser holds. Every route answers (2xx, or a redirect) or
 * refuses with a reason — never a 5xx, and never a body the browser client
 * cannot read.
 *
 * The routes are read off `app.routes` and compared with the daemon lane's
 * rules, so a router added to server mode without a rule fails here, and one
 * added to the daemon composition fails there.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  signInProvidersResponseSchema,
  signInSessionResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/sign-in'
import {
  administratorResponseSchema,
  deactivationResponseSchema,
  deletionResponseSchema,
  tenantPeopleResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/tenant-people'
import {
  addWorkspacePersonRequestSchema,
  changeWorkspaceRoleRequestSchema,
  invitationLinkResponseSchema,
  removeWorkspacePersonResponseSchema,
  workspacePeopleResponseSchema,
  workspacePersonSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/workspace-people'
import { afterAll, beforeAll, describe, expect, vi } from 'vitest'
import { fakeOidcProvider } from '../shared/test-utils/fake-oidc-provider.js'
import { fc, fcTest } from '../shared/test-utils/fast-check.js'
import { RULES as DAEMON_RULES } from './_test-route-fuzz-daemon-rules.js'
import {
  assertLedger,
  fuzzRows,
  type Harness,
  type Rule,
  registeredKeys,
  segmentArb,
  type Target,
} from './_test-route-fuzz-lane.js'
import {
  bearerNamesItsSubject,
  IDP,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
} from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { testDataLayout } from './routes/_test-helpers.js'
import { createCompleteSignInDeps } from './security/complete-sign-in.js'
import { createRelyingParty } from './security/oidc-relying-party.js'
import { createSignInAttemptStore } from './security/sign-in-attempt-store.js'
import { providerAuthenticator, signInConfigSchema } from './security/sign-in-config.js'
import { SESSION_COOKIE } from './security/sign-in-session-store.js'
import { createIsolatedDb } from './store/db/test-helpers.js'

let tempDir = ''
// One data dir per seeded app: the legacy document store is module-level and
// caches by path, so reusing a path across seeds would read the previous
// seed's cache over a fresh database.
let dataDir = ''

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
  get DIST_WEB_APP_DIR() {
    return join(tempDir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createApp } = await import('./app.js')
const { createContainer, resolveServerDeps } = await import('../di/container.js')
const { clearCache } = await import('./store/doc-cache.js')
const { _clearWorkspaceDocCacheForTests } = await import('./store/document-store.js')
const { resetSyncStreamsForTests } = await import('./routes/sync-sse.js')

const HOUR = 60 * 60 * 1000
const PERSON_NAMES = ['admin', 'admin2', 'member', 'active', 'victim'] as const
type PersonName = (typeof PERSON_NAMES)[number]
/** What a seeded sign-in attempt asks to be returned to — hostile ones included. */
const RETURNS = ['/w/plans', '//evil.example', '/\\evil.example', 'https://evil.example'] as const

const RULES: Record<string, Rule> = {
  'GET /api/workspaces/:workspace/people': {
    answers: 'json',
    response: workspacePeopleResponseSchema,
  },
  'POST /api/workspaces/:workspace/people': {
    answers: 'json',
    body: addWorkspacePersonRequestSchema,
    response: workspacePersonSchema,
  },
  'PATCH /api/workspaces/:workspace/people/:userId': {
    answers: 'json',
    body: changeWorkspaceRoleRequestSchema,
    response: workspacePersonSchema,
  },
  'DELETE /api/workspaces/:workspace/people/:userId': {
    answers: 'json',
    response: removeWorkspacePersonResponseSchema,
  },
  'POST /api/workspaces/:workspace/invitations': {
    answers: 'json',
    response: invitationLinkResponseSchema,
  },
  'GET /api/people': { answers: 'json', response: tenantPeopleResponseSchema },
  'POST /api/people/:userId/deactivation': {
    answers: 'json',
    response: deactivationResponseSchema,
  },
  'DELETE /api/people/:userId/deactivation': {
    answers: 'json',
    response: deactivationResponseSchema,
  },
  'DELETE /api/people/:userId': { answers: 'json', response: deletionResponseSchema },
  'PUT /api/people/:userId/administrator': {
    answers: 'json',
    response: administratorResponseSchema,
  },
  'DELETE /api/people/:userId/administrator': {
    answers: 'json',
    response: administratorResponseSchema,
  },
  'POST /api/invitations': { answers: 'json', response: invitationLinkResponseSchema },
  'GET /auth/providers': { answers: 'json', response: signInProvidersResponseSchema },
  'GET /auth/session': { answers: 'json', response: signInSessionResponseSchema },
  'GET /auth/sign-in/:providerId': { answers: 'redirect' },
  'GET /auth/reauthenticate': { answers: 'redirect' },
  'GET /auth/callback/:providerId': { answers: 'redirect' },
  'POST /auth/sign-out': { answers: 'none' },
}

/** The user a row's happy draw aims at: one for whom the change is neither refused nor a no-op. */
const HAPPY_USER: Record<string, PersonName> = {
  'POST /api/people/:userId/deactivation': 'active',
  'DELETE /api/people/:userId/deactivation': 'victim',
  'DELETE /api/people/:userId': 'victim',
  'PUT /api/people/:userId/administrator': 'active',
  'DELETE /api/people/:userId/administrator': 'admin2',
  'PATCH /api/workspaces/:workspace/people/:userId': 'member',
  'DELETE /api/workspaces/:workspace/people/:userId': 'member',
}

interface Seed {
  readonly app: ReturnType<typeof createApp>
  readonly workspaceId: string
  readonly userIds: Record<PersonName, string>
  /** A session cookie per person, as a browser sends it. */
  readonly cookies: Record<PersonName | 'oidc', string>
  /** Sign-in attempts begun and sent to the provider, each ready to come back to the callback. */
  readonly callbacks: readonly { readonly search: string; readonly cookie: string }[]
  dispose(): Promise<void>
}

const providers = signInConfigSchema
  .parse({
    providers: [
      {
        id: 'corp',
        kind: 'oidc',
        issuer: IDP,
        clientId: 'wb',
        clientSecret: { env: 'CORP_SECRET' },
        admission: { createAccounts: true },
      },
    ],
  })
  .providers.map((p) => ({ ...p, clientSecretValue: 's3cret', clientId: 'wb' }))

type Idp = Awaited<ReturnType<typeof fakeOidcProvider>>
type Stores = ReturnType<typeof serverModePeople>

function composedApp(
  handle: Awaited<ReturnType<typeof createIsolatedDb>>,
  stores: Stores,
  idp: Idp,
) {
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps: resolveServerDeps(createContainer()),
    dataLayout: testDataLayout(),
    people: stores.people,
    signIn: {
      providers,
      rp: createRelyingParty({ fetch: idp.fetch }),
      attempts: createSignInAttemptStore(handle.db),
      signIn: createCompleteSignInDeps(handle.db, HOUR),
      administrators: stores.people.administration.check,
      publicBaseUrl: PUBLIC_URL,
    },
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  return createApp(options)
}

/** Five people in the tenant and one signed in through the provider; two administer, one is deactivated. */
async function seededPeople({ members, sessions, people }: Stores) {
  const cookieFor = async (binding: { authenticator: string; subject: string }) => {
    // A session recent enough to administer with, and one that outlasts the row.
    const token = await sessions.create(binding, Date.now(), HOUR, Date.now())
    return `${SESSION_COOKIE}=${token}`
  }
  const userIds = {} as Record<PersonName, string>
  const cookies = {} as Record<PersonName | 'oidc', string>
  for (const name of PERSON_NAMES) {
    const binding = { authenticator: ISSUER, subject: name }
    userIds[name] = (await members.ensureProfile({ binding, displayName: name })).id
    cookies[name] = await cookieFor(binding)
  }
  // The authenticator the provider's own sign-ins carry, so re-authenticating has one to ask.
  const oidc = { authenticator: providerAuthenticator({ issuer: IDP }), subject: 'oidc-person' }
  await members.ensureProfile({ binding: oidc, displayName: 'oidc-person' })
  cookies.oidc = await cookieFor(oidc)

  const { appointments, deactivation } = people.administration
  await appointments.appoint(userIds.admin, null)
  await appointments.appoint(userIds.admin2, userIds.admin)
  // Deactivated up front: deleting is final and refuses anyone still active.
  await deactivation.deactivate(userIds.victim, Date.now())
  return { userIds, cookies }
}

async function seededWorkspace(
  app: ReturnType<typeof createApp>,
  stores: Stores,
  seeded: Awaited<ReturnType<typeof seededPeople>>,
) {
  const created = await app.request(`${PUBLIC_URL}/api/workspaces`, {
    method: 'POST',
    headers: {
      cookie: seeded.cookies.admin,
      origin: PUBLIC_URL,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ displayName: 'Plans' }),
  })
  if (created.status !== 201) throw new Error(`seed workspace failed: ${created.status}`)
  const { workspaceId } = (await created.json()) as { workspaceId: string }
  await stores.members.addMember(workspaceId, seeded.userIds.member)
  return workspaceId
}

/** Each return target begun with the provider and sent through it, left waiting at the callback. */
async function seededCallbacks(app: ReturnType<typeof createApp>, idp: Idp) {
  idp.next({ sub: 'newcomer', email: 'newcomer@corp.example', email_verified: true, name: 'New' })
  const callbacks: { search: string; cookie: string }[] = []
  for (const returnTo of RETURNS) {
    const started = await app.request(
      `${PUBLIC_URL}/auth/sign-in/corp?return=${encodeURIComponent(returnTo)}`,
    )
    const cookie = started.headers
      .getSetCookie()
      .find((c) => c.startsWith('__Host-wb_signin='))
      ?.split(';')[0]
    const location = started.headers.get('location')
    if (started.status !== 302 || cookie === undefined || location === null) {
      throw new Error(`seed sign-in failed: ${started.status}`)
    }
    callbacks.push({ search: new URL(idp.authorize(location)).search, cookie })
  }
  return callbacks
}

async function seededApp(idp: Idp): Promise<Seed> {
  const dir = await mkdtemp(join(tempDir, 'server-mode-'))
  dataDir = dir
  clearCache()
  _clearWorkspaceDocCacheForTests()
  const handle = await createIsolatedDb({ dataDir: dir })
  const stores = serverModePeople(handle.db, dir)
  const app = composedApp(handle, stores, idp)
  const seeded = await seededPeople(stores)
  return {
    app,
    ...seeded,
    workspaceId: await seededWorkspace(app, stores, seeded),
    callbacks: await seededCallbacks(app, idp),
    dispose: async () => {
      resetSyncStreamsForTests()
      await handle.dispose()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

type Headers = Record<string, string>

/** Who calls `/api`: mostly an administrator, signed in the way a browser is, and the ways that is refused. */
function apiHeadersArb(seed: Seed): fc.Arbitrary<Headers> {
  const browser = (cookie: string): Headers => ({ cookie, origin: PUBLIC_URL })
  return fc.oneof(
    { weight: 6, arbitrary: fc.constant(browser(seed.cookies.admin)) },
    { weight: 2, arbitrary: fc.constant(browser(seed.cookies.member)) },
    // A cookie without the origin a browser sends beside it, a bearer, and nobody.
    { weight: 1, arbitrary: fc.constant({ cookie: seed.cookies.admin }) },
    { weight: 1, arbitrary: fc.constant({ authorization: 'Bearer admin' }) },
    { weight: 1, arbitrary: fc.constant({}) },
  )
}

/** Who calls `/auth`: a session from the provider, one from elsewhere, nobody, or a forgery. */
function authHeadersArb(seed: Seed): fc.Arbitrary<Headers> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.constant({ cookie: seed.cookies.oidc }) },
    { weight: 1, arbitrary: fc.constant({ cookie: seed.cookies.admin }) },
    { weight: 1, arbitrary: fc.constant({}) },
    {
      weight: 1,
      arbitrary: fc.string({ maxLength: 12 }).map((v) => ({ cookie: `${SESSION_COOKIE}=${v}` })),
    },
  )
}

const queryOf = (params: Record<string, string>) => `?${new URLSearchParams(params)}`
const SHORT = fc.string({ maxLength: 12 })
const queryArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant('') },
  {
    weight: 2,
    arbitrary: fc.record({ return: SHORT, invitation: SHORT }).map(queryOf),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({ state: SHORT, code: SHORT, iss: fc.constantFrom(IDP, 'https://other.test') })
      .map(queryOf),
  },
)

/** A parameter's value, aimed at the seed at real weight and otherwise anywhere. */
const aimedAt = (aimed: string, others: readonly string[]) =>
  fc.oneof(
    { weight: 5, arbitrary: fc.constantFrom(aimed, ...others) },
    { weight: 1, arbitrary: fc.constant('nowhere') },
    { weight: 1, arbitrary: segmentArb },
  )

function fillPattern(seed: Seed, key: string, pattern: string, happy: boolean) {
  const user = seed.userIds[HAPPY_USER[key] ?? 'member']
  const valueFor = (segment: string): fc.Arbitrary<string> => {
    if (segment === ':workspace') {
      return happy ? fc.constant(seed.workspaceId) : aimedAt(seed.workspaceId, [])
    }
    if (segment === ':userId') {
      return happy ? fc.constant(user) : aimedAt(user, Object.values(seed.userIds))
    }
    if (segment === ':providerId') return happy ? fc.constant('corp') : aimedAt('corp', [])
    return fc.constant(segment)
  }
  return fc
    .tuple(...pattern.split('/').map(valueFor))
    .map((values) => values.map(encodeURIComponent).join('/'))
}

/** The draw that comes back through the provider: one of the attempts the seed left waiting. */
function happyCallback(seed: Seed, path: string): fc.Arbitrary<Target> {
  return fc
    .constantFrom(...seed.callbacks)
    .map(({ search, cookie }) => ({ path: `${path}${search}`, headers: { cookie } }))
}

function targetFor(seed: Seed, key: string, pattern: string): fc.Arbitrary<Target> {
  const isAuth = pattern.startsWith('/auth/')
  const signedInByProvider = key === 'GET /auth/reauthenticate' || key === 'GET /auth/session'
  const happy = fillPattern(seed, key, pattern, true).chain((path): fc.Arbitrary<Target> => {
    if (key === 'GET /auth/callback/:providerId') return happyCallback(seed, path)
    const cookie = signedInByProvider ? seed.cookies.oidc : seed.cookies.admin
    const headers: Headers = isAuth ? { cookie } : { cookie, origin: PUBLIC_URL }
    return fc.constant({ path, headers })
  })
  const drawn = fc
    .tuple(
      fillPattern(seed, key, pattern, false),
      isAuth ? queryArb : fc.constant(''),
      isAuth ? authHeadersArb(seed) : apiHeadersArb(seed),
    )
    .map(([path, query, headers]): Target => ({ path: `${path}${query}`, headers }))
  return fc.oneof({ weight: 1, arbitrary: happy }, { weight: 3, arbitrary: drawn })
}

function harnessFor(seed: Seed): Harness {
  return {
    request: (path, init) => seed.app.request(`${PUBLIC_URL}${path}`, init),
    target: (key, pattern) => targetFor(seed, key, pattern),
    override: (path) =>
      path.endsWith('userId')
        ? fc.constantFrom(...Object.values(seed.userIds), 'nowhere')
        : undefined,
    dispose: seed.dispose,
  }
}

const answered = new Map<string, number>()
let registered: string[] = []
let idp: Idp

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-server-mode-routes-fuzz-'))
  // Server mode serves a web build from here; an empty directory answers the
  // placeholder instead of logging that the root is missing on every row.
  await mkdir(join(tempDir, 'web-app'))
  idp = await fakeOidcProvider(IDP, 'wb')
  const probe = await seededApp(idp)
  registered = registeredKeys(probe.app)
  await probe.dispose()
})

afterAll(async () => {
  resetSyncStreamsForTests()
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('every route only server mode mounts answers or refuses with a reason, never a 5xx', () => {
  fcTest.prop([fc.constant(null)])(
    'every route server mode adds to the daemon composition has a rule, and every rule a route',
    () => {
      const shared = new Set(Object.keys(DAEMON_RULES))
      const only = registered.filter((key) => !shared.has(key))
      // The people and sign-in routers: a count far below that is a fixture
      // that composed without them, not a smaller surface.
      expect(only.length).toBeGreaterThanOrEqual(18)
      expect(only).toEqual(Object.keys(RULES).sort())
    },
  )

  fuzzRows(RULES, answered, async () => harnessFor(await seededApp(idp)))

  afterAll(() => assertLedger(RULES, answered))
})
