import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as daemonUrls from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import * as documentUrls from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import {
  DOCUMENT_API_ACTIONS,
  type DocumentApiAction,
  WORKSPACE_DOCUMENT_API_ACTIONS,
  type WorkspaceDocumentApiAction,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOidcProvider } from '../shared/test-utils/fake-oidc-provider.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import {
  bearerNamesItsSubject,
  IDP,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
  serverModeSignIn,
} from './_test-server-mode-harness.js'
import { testDataLayout, withTempDataDir } from './routes/_test-helpers.js'
import type { SignInRoutesDeps } from './routes/sign-in.js'
import { DENY_ALL_STRATEGY } from './security/_test-helpers.js'
import { createRelyingParty } from './security/oidc-relying-party.js'
import { createWorkspaceReplicaKeyStore } from './security/workspace-replica-key-store.js'
import { createIsolatedDb, type IsolatedDbHandle } from './store/db/test-helpers.js'

const tmp = withTempDataDir('whiteboard-client-urls-')

// A block that builds its app once, in `beforeAll`, points the data dir at its
// own directory for its lifetime (`blockDir`); everything else gets the test's.
let blockDataRoot: string | undefined
const dataRoot = () => blockDataRoot ?? tmp.dir

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(dataRoot(), 'data')
  },
  getDataDir: () => join(dataRoot(), 'data'),
  get DIST_WEB_APP_DIR() {
    return join(dataRoot(), 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createApp } = await import('./app.js')
const { createContainer, resolveServerDeps } = await import('../di/container.js')
const { clearDocCacheForTests } = await import('./store/doc-cache.js')
const { PACKAGE_VERSION } = await import('../shared/package-version.js')

/**
 * A directory for one describe block's database. `tmp` is per TEST: in a
 * `beforeAll` it still names the previous test's directory, which that test's
 * teardown already removed, so anything written there re-created it and
 * nothing removed it again. Registered before the block's own hooks, so it
 * exists before the database opens and is removed after the database closes.
 * `holdsDataDir` is for a block whose app is built in `beforeAll`: building
 * one writes into the data dir, so the block's lifetime is the data dir's.
 */
function blockDir(prefix: string, { holdsDataDir = false } = {}): { readonly dir: string } {
  const held = { dir: '' }
  beforeAll(async () => {
    held.dir = await mkdtemp(join(tmpdir(), prefix))
    if (holdsDataDir) blockDataRoot = held.dir
  })
  afterAll(async () => {
    if (holdsDataDir) blockDataRoot = undefined
    await rm(held.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  return held
}

const TOKEN = 'urls-token'
const WS = 'ws-urls'

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

interface Sample {
  readonly label: string
  readonly method: Method
  readonly url: string
}

// The method each action is served under. Typed over the closed sets, so a
// new action cannot be added without saying here how it is requested.
const DOCUMENT_ACTION_METHODS: Record<DocumentApiAction, Method> = {
  snapshot: 'GET',
  update: 'POST',
  export: 'POST',
  'export-svg': 'POST',
  'client-count': 'GET',
}
const WORKSPACE_DOCUMENT_ACTION_METHODS: Record<WorkspaceDocumentApiAction, Method> = {
  snapshot: 'GET',
  update: 'POST',
  promote: 'POST',
}

const DOC = 'notes/plan'
const doc = [WS, DOC] as const

// One entry per builder, keyed by its export name. A builder with no entry
// fails the completeness test below, so adding one means pinning it here.
const SAMPLES: Record<string, readonly Sample[]> = {
  documentApiUrl: DOCUMENT_API_ACTIONS.map((action) => ({
    label: action,
    method: DOCUMENT_ACTION_METHODS[action],
    url: documentUrls.documentApiUrl(...doc, action),
  })),
  documentFileApiUrl: [
    { label: 'file', method: 'GET', url: documentUrls.documentFileApiUrl(...doc, 'img1') },
    { label: 'upload', method: 'PUT', url: documentUrls.documentFileApiUrl(...doc, 'img1') },
  ],
  workspaceDocumentApiUrl: WORKSPACE_DOCUMENT_API_ACTIONS.map((action) => ({
    label: action,
    method: WORKSPACE_DOCUMENT_ACTION_METHODS[action],
    url: documentUrls.workspaceDocumentApiUrl(WS, action),
  })),
  workspacesApiUrl: [
    { label: 'list', method: 'GET', url: daemonUrls.workspacesApiUrl() },
    { label: 'create', method: 'POST', url: daemonUrls.workspacesApiUrl() },
  ],
  workspaceApiUrl: [{ label: 'rename', method: 'PATCH', url: daemonUrls.workspaceApiUrl(WS) }],
  workspaceNamesApiUrl: [
    { label: 'names', method: 'GET', url: daemonUrls.workspaceNamesApiUrl(WS) },
  ],
  workspaceDocumentsApiUrl: [
    { label: 'list', method: 'GET', url: daemonUrls.workspaceDocumentsApiUrl(WS) },
  ],
  documentRecordApiUrl: [
    { label: 'delete', method: 'DELETE', url: daemonUrls.documentRecordApiUrl(...doc) },
  ],
  documentPathApiUrl: [
    { label: 'move', method: 'PUT', url: daemonUrls.documentPathApiUrl(...doc) },
  ],
  documentNameApiUrl: [
    { label: 'name', method: 'PUT', url: daemonUrls.documentNameApiUrl(...doc) },
  ],
  documentPinApiUrl: [{ label: 'pin', method: 'PUT', url: daemonUrls.documentPinApiUrl(...doc) }],
  documentDuplicateApiUrl: [
    { label: 'duplicate', method: 'POST', url: daemonUrls.documentDuplicateApiUrl(...doc) },
  ],
  documentVersionsApiUrl: [
    { label: 'list', method: 'GET', url: daemonUrls.documentVersionsApiUrl(...doc) },
    { label: 'save', method: 'POST', url: daemonUrls.documentVersionsApiUrl(...doc) },
  ],
  versionDocumentApiUrl: [
    { label: 'read', method: 'GET', url: daemonUrls.versionDocumentApiUrl(...doc, 'v1') },
  ],
  versionRestoreApiUrl: [
    { label: 'restore', method: 'POST', url: daemonUrls.versionRestoreApiUrl(...doc, 'v1') },
  ],
  trashApiUrl: [{ label: 'list', method: 'GET', url: daemonUrls.trashApiUrl(WS) }],
  trashEntryApiUrl: [
    { label: 'purge', method: 'DELETE', url: daemonUrls.trashEntryApiUrl(WS, 'doc1') },
  ],
  trashRestoreApiUrl: [
    { label: 'restore', method: 'POST', url: daemonUrls.trashRestoreApiUrl(WS, 'doc1') },
  ],
  optimizeAllApiUrl: [{ label: 'optimize', method: 'POST', url: daemonUrls.optimizeAllApiUrl(WS) }],
  pruneSandwichedApiUrl: [
    { label: 'prune', method: 'POST', url: daemonUrls.pruneSandwichedApiUrl(WS) },
  ],
  purgeDanglingApiUrl: [
    { label: 'purge', method: 'POST', url: daemonUrls.purgeDanglingApiUrl(WS) },
  ],
  storageReportApiUrl: [{ label: 'report', method: 'GET', url: daemonUrls.storageReportApiUrl() }],
  runtimePingApiUrl: [{ label: 'ping', method: 'GET', url: daemonUrls.runtimePingApiUrl() }],
  replicaKeyApiUrl: [{ label: 'issue', method: 'POST', url: daemonUrls.replicaKeyApiUrl(WS) }],
  replicaKeyRotateApiUrl: [
    { label: 'rotate', method: 'POST', url: daemonUrls.replicaKeyRotateApiUrl(WS) },
  ],
  replicaTierApiUrl: [{ label: 'set', method: 'PUT', url: daemonUrls.replicaTierApiUrl(WS) }],
  runtimeStatusApiUrl: [{ label: 'status', method: 'GET', url: daemonUrls.runtimeStatusApiUrl() }],
  syncStreamApiUrl: [{ label: 'open', method: 'GET', url: daemonUrls.syncStreamApiUrl() }],
  syncSubscribeApiUrl: [
    { label: 'subscribe', method: 'POST', url: daemonUrls.syncSubscribeApiUrl() },
  ],
  syncMessageApiUrl: [{ label: 'message', method: 'POST', url: daemonUrls.syncMessageApiUrl() }],
  documentsV1ApiUrl: [{ label: 'create', method: 'POST', url: daemonUrls.documentsV1ApiUrl(WS) }],
  documentBacklinksApiUrl: [
    { label: 'backlinks', method: 'GET', url: daemonUrls.documentBacklinksApiUrl(WS, 'doc1') },
  ],
  linkifyMentionsApiUrl: [
    { label: 'linkify', method: 'POST', url: daemonUrls.linkifyMentionsApiUrl(WS, 'doc1') },
  ],
  documentOkfApiUrl: [
    { label: 'okf', method: 'GET', url: daemonUrls.documentOkfApiUrl(WS, 'doc1') },
  ],
  documentTagsApiUrl: [{ label: 'tags', method: 'GET', url: daemonUrls.documentTagsApiUrl(WS) }],
  searchApiUrl: [
    {
      label: 'search',
      method: 'GET',
      url: daemonUrls.searchApiUrl(WS, { query: 'plan', tags: ['a'], limit: 5 }),
    },
  ],
  fontsApiUrl: [{ label: 'list', method: 'GET', url: daemonUrls.fontsApiUrl() }],
  fontInstallApiUrl: [
    { label: 'install', method: 'POST', url: daemonUrls.fontInstallApiUrl('f1') },
  ],
  fontFileApiUrl: [{ label: 'file', method: 'GET', url: daemonUrls.fontFileApiUrl('f1') }],
}

// The people routes (ADR-0049) mount only on a server-mode keeper with people
// to manage, so these are requested against that app, below.
const SERVER_MODE_SAMPLES: Record<string, readonly Sample[]> = {
  tenantPeopleApiUrl: [{ label: 'list', method: 'GET', url: daemonUrls.tenantPeopleApiUrl() }],
  tenantPersonApiUrl: [
    { label: 'delete', method: 'DELETE', url: daemonUrls.tenantPersonApiUrl('u1') },
  ],
  tenantPersonDeactivationApiUrl: [
    { label: 'deactivate', method: 'POST', url: daemonUrls.tenantPersonDeactivationApiUrl('u1') },
    {
      label: 'reactivate',
      method: 'DELETE',
      url: daemonUrls.tenantPersonDeactivationApiUrl('u1'),
    },
  ],
  tenantPersonAdministratorApiUrl: [
    { label: 'appoint', method: 'PUT', url: daemonUrls.tenantPersonAdministratorApiUrl('u1') },
    {
      label: 'dismiss',
      method: 'DELETE',
      url: daemonUrls.tenantPersonAdministratorApiUrl('u1'),
    },
  ],
  tenantInvitationsApiUrl: [
    { label: 'invite', method: 'POST', url: daemonUrls.tenantInvitationsApiUrl() },
  ],
  workspacePeopleApiUrl: [
    { label: 'list', method: 'GET', url: daemonUrls.workspacePeopleApiUrl(WS) },
  ],
  workspacePersonApiUrl: [
    { label: 'role', method: 'PATCH', url: daemonUrls.workspacePersonApiUrl(WS, 'u1') },
    { label: 'remove', method: 'DELETE', url: daemonUrls.workspacePersonApiUrl(WS, 'u1') },
  ],
  workspaceInvitationsApiUrl: [
    { label: 'invite', method: 'POST', url: daemonUrls.workspaceInvitationsApiUrl(WS) },
  ],
}

/** Every builder the two modules export; the `ApiUrl` suffix is the convention that names one. */
const BUILDERS = Object.entries({ ...documentUrls, ...daemonUrls })
  .filter(([name, value]) => name.endsWith('ApiUrl') && typeof value === 'function')
  .map(([name]) => name)

/**
 * The app's not-found answer: Hono's plain text outside `/api`, and under it
 * `answerNotFound`'s JSON naming the request. A route that refuses something
 * it understood answers JSON too, so the content type alone cannot tell the
 * two apart under `/api` — the check has to read what was said.
 *
 * Server mode answers an `/api` path outside every declared route scope with
 * `500 auth.route-undeclared` before the router runs, so a renamed route ROOT
 * is never a 404 there; that refusal means "no route" as surely as one.
 */
async function unmatched(res: Response): Promise<boolean> {
  if (res.status !== 404 && res.status !== 500) return false
  if (res.status === 404 && (res.headers.get('content-type') ?? '').startsWith('text/plain')) {
    return true
  }
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null)
  const field = (key: string) =>
    typeof body === 'object' && body !== null && key in body
      ? (body as Record<string, unknown>)[key]
      : undefined
  if (res.status === 500) return field('error') === 'auth.route-undeclared'
  const message = field('message')
  return typeof message === 'string' && message.startsWith('No route answers ')
}

const sampleRows = (samples: Record<string, readonly Sample[]>) =>
  Object.entries(samples).flatMap(([builder, rows]) => rows.map((row) => ({ builder, ...row })))

const requestInit = (method: Method, authorization: string): RequestInit => ({
  method,
  headers: { Authorization: authorization, 'content-type': 'application/json' },
  body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
})

it('has a sample for exactly the builders the modules export, each in one app', () => {
  // A floor, so an enumeration that found nothing cannot pass.
  expect(BUILDERS.length).toBeGreaterThan(35)
  const sampled = [...Object.keys(SAMPLES), ...Object.keys(SERVER_MODE_SAMPLES)]
  expect([...BUILDERS].sort()).toEqual([...sampled].sort())
})

describe('daemon client URLs reach a route', () => {
  const block = blockDir('whiteboard-client-urls-local-')
  let db: IsolatedDbHandle

  beforeAll(async () => {
    db = await createIsolatedDb({ dataDir: join(block.dir, 'local-db') })
  })
  afterAll(async () => {
    await db.dispose()
  })
  beforeEach(() => {
    clearDocCacheForTests()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The workspace every sample names exists: the handle resolver answers an
  // unknown workspace before any route under it is matched, so against a
  // missing one each of those samples would pass whatever its path.
  async function localDaemonApp() {
    const serverDeps = resolveServerDeps(createContainer(storeMemoryModule))
    await serverDeps.documentIndex.createWorkspace({ workspaceId: WS, segment: 'urls' })
    await serverDeps.workspaceDocuments.save(WS, await serverDeps.workspaceDocuments.get(WS))
    return createApp({
      authMode: 'local-daemon',
      token: TOKEN,
      serverDeps,
      dataLayout: testDataLayout(),
      replicaKeys: createWorkspaceReplicaKeyStore(db.db, { defaultTier: 'offline' }),
      touch: vi.fn(),
      getStatus: () => ({
        ok: true,
        pid: 10,
        version: PACKAGE_VERSION,
        startedAt: '2026-04-23T00:00:00.000Z',
        uptimeMs: 100,
        idleForMs: 10,
        auth: { mode: 'local-token', hasToken: true },
        storage: { dataDir: '/tmp', dataDirWritable: true },
        mcp: { httpEnabled: true },
        clients: { connected: 0, ready: 0 },
      }),
    } as never)
  }

  // The control: without it, a predicate that never says "unmatched" passes
  // every sample below, renamed route or not.
  it.each([
    '/api/runtime/no-such-route',
    '/api/no-such-root',
  ])('tells a mounted route from %s, which no route serves', async (path) => {
    const res = await (await localDaemonApp()).request(path, requestInit('GET', `Bearer ${TOKEN}`))
    expect(await unmatched(res), `-> ${res.status}`).toBe(true)
  })

  it.each(sampleRows(SAMPLES))('$builder $label ($method) is served by a route', async ({
    method,
    url,
  }) => {
    const res = await (await localDaemonApp()).request(url, requestInit(method, `Bearer ${TOKEN}`))
    // The sync stream's body never ends on its own; the headers are the
    // answer, and cancelling the body closes the stream it opened.
    const isUnmatched = await unmatched(res).finally(() => res.body?.cancel())
    expect(isUnmatched, `${method} ${url} -> ${res.status}`).toBe(false)
  })
})

describe('daemon client people URLs reach a server-mode route', () => {
  const block = blockDir('whiteboard-client-urls-people-', { holdsDataDir: true })
  let db: IsolatedDbHandle
  let app: ReturnType<typeof createApp>

  // The person asking owns WS: the membership gate answers a workspace path
  // before any route under it is matched, so for a stranger each of the
  // workspace samples would pass whatever its path.
  beforeAll(async () => {
    db = await createIsolatedDb({ dataDir: join(block.dir, 'people-db') })
    const stores = serverModePeople(db.db, block.dir)
    const serverDeps = resolveServerDeps(createContainer(storeMemoryModule))
    await serverDeps.documentIndex.createWorkspace({ workspaceId: WS, segment: 'urls' })
    const asker = await stores.members.ensureProfile({
      binding: { authenticator: ISSUER, subject: 'alice' },
      displayName: 'alice',
    })
    await stores.members.addMember(WS, asker.id)
    app = createApp({
      authMode: 'server-mode',
      publicBaseUrl: PUBLIC_URL,
      allowedOrigins: [PUBLIC_URL],
      serverDeps,
      dataLayout: testDataLayout(),
      authStrategy: bearerNamesItsSubject,
      people: stores.people,
      touch: () => {},
      getStatus: () => ({}) as never,
    })
  })
  afterAll(async () => {
    await db.dispose()
  })

  // The controls: a request has to get past server mode's auth and the
  // membership gate to the router, or every sample below would be refused
  // before matching, and a refusal is JSON whether or not a route exists.
  // The top-level one is what a renamed route ROOT looks like: no declared
  // scope covers it, so server mode refuses it before the router runs.
  it.each([
    '/api/people/u1/no-such-route',
    `/api/workspaces/${WS}/no-such-route`,
    '/api/no-such-root',
  ])('tells a mounted route from %s, which no route serves', async (path) => {
    const res = await app.request(`${PUBLIC_URL}${path}`, requestInit('POST', 'Bearer alice'))
    expect(await unmatched(res), `-> ${res.status}`).toBe(true)
  })

  it.each(
    sampleRows(SERVER_MODE_SAMPLES),
  )('$builder $label ($method) is served by a route', async ({ method, url }) => {
    const res = await app.request(`${PUBLIC_URL}${url}`, requestInit(method, 'Bearer alice'))
    expect(await unmatched(res), `${method} ${url} -> ${res.status}`).toBe(false)
  })
})

// The `/auth` routes exist only in server mode, and only when a provider is
// configured (ADR-0046), so they are requested against that app. Their builders
// do not end in `ApiUrl` because they sit outside `/api`.
const AUTH_SAMPLES: Record<string, readonly Sample[]> = {
  authProvidersUrl: [{ label: 'providers', method: 'GET', url: daemonUrls.authProvidersUrl() }],
  authSignInUrl: [{ label: 'begin', method: 'GET', url: daemonUrls.authSignInUrl('corp') }],
  authSessionUrl: [{ label: 'session', method: 'GET', url: daemonUrls.authSessionUrl() }],
  authSignOutUrl: [{ label: 'sign out', method: 'POST', url: daemonUrls.authSignOutUrl() }],
  authReauthenticateUrl: [
    { label: 'reauthenticate', method: 'GET', url: daemonUrls.authReauthenticateUrl() },
  ],
}

const AUTH_BUILDERS = Object.entries(daemonUrls)
  .filter(([name, value]) => /^auth\w*Url$/.test(name) && typeof value === 'function')
  .map(([name]) => name)

describe('daemon client /auth URLs reach a server-mode route', () => {
  const block = blockDir('whiteboard-client-urls-auth-', { holdsDataDir: true })
  let db: IsolatedDbHandle
  let app: ReturnType<typeof createApp>
  let signIn: SignInRoutesDeps

  beforeAll(async () => {
    db = await createIsolatedDb({ dataDir: join(block.dir, 'auth-db') })
    const idp = await fakeOidcProvider(IDP, 'wb')
    signIn = serverModeSignIn(db.db, createRelyingParty({ fetch: idp.fetch }))
    app = createApp({
      authMode: 'server-mode',
      publicBaseUrl: PUBLIC_URL,
      allowedOrigins: [PUBLIC_URL],
      serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
      dataLayout: testDataLayout(),
      authStrategy: DENY_ALL_STRATEGY,
      people: serverModePeople(db.db, block.dir).people,
      touch: () => {},
      getStatus: () => ({}) as never,
      signIn,
    })
  })
  afterAll(async () => {
    await db.dispose()
  })

  it('has a sample for exactly the builders the module exports', () => {
    expect(AUTH_BUILDERS.length).toBeGreaterThan(3)
    expect([...AUTH_BUILDERS].sort()).toEqual(Object.keys(AUTH_SAMPLES).sort())
  })

  // The control: an `/auth` path no route serves is refused like an `/api`
  // one rather than answered with the UI's shell, so a JSON content type alone
  // would hold for a renamed route too.
  it('tells a mounted route from an /auth path no route serves', async () => {
    const res = await app.request(`${PUBLIC_URL}/auth/no-such-route`)
    expect(await unmatched(res), `-> ${res.status}`).toBe(true)
  })

  it.each(sampleRows(AUTH_SAMPLES))('$builder $label ($method) is served by a route', async ({
    method,
    url,
  }) => {
    const res = await app.request(`${PUBLIC_URL}${url}`, { method })
    const contentType = res.headers.get('content-type') ?? ''
    // Each route answers JSON, a redirect, or nothing at all (sign-out); an
    // unserved one answers the JSON refusal `unmatched` recognises.
    const served =
      [204, 302].includes(res.status) ||
      (contentType.startsWith('application/json') && !(await unmatched(res)))
    expect(served, `${method} ${url} -> ${res.status} ${contentType}`).toBe(true)
  })

  // The web app builds this link and the keeper reads it, so the query keys
  // are checked by driving the one into the other: the attempt the keeper
  // stores is what its callback later admits and redirects with.
  it('a sign-in link keeps both its invitation and where to return to', async () => {
    const url = daemonUrls.authSignInUrl('corp', { returnTo: '/w/x', invitation: 'inv-123' })
    const res = await app.request(`${PUBLIC_URL}${url}`)
    expect(res.status, res.headers.get('location') ?? '').toBe(302)
    const state = new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const binding = /__Host-wb_signin=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? ''
    const attempt = await signIn.attempts.take(state, binding, Date.now())
    expect(attempt).toMatchObject({ returnTo: '/w/x', invitationToken: 'inv-123' })
  })
})
