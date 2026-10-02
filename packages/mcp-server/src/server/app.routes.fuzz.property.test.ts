/**
 * Every HTTP route the local daemon registers, requested with what its own
 * input schema admits — and with what it does not.
 *
 * server-core's `create-server.routes.fuzz` covers the `/api/v1` surface it
 * owns; this is the same question asked of everything else `createApp`
 * mounts: the legacy `/api/workspaces` and `/api/w` document routes, sync,
 * runtime, fonts, files, export, debug and the OAuth metadata. A route may
 * answer (2xx, or 501 saying the composition lacks the feature), or refuse a
 * request it understood (4xx with a JSON body naming why) — never a 5xx, and
 * never a body the browser client cannot read.
 *
 * The routers only server mode mounts (a workspace's people, the tenant's
 * people, sign-in) need a signed-in person and an OIDC provider to answer
 * anything but a refusal, so they are
 * `app.routes.fuzz.server-mode.property.test.ts`'s. That lane reads this
 * lane's rules to tell them from the routes both compositions serve.
 *
 * Routes are read off `app.routes`, so one added without a rule here fails.
 * The three wildcard patterns dispatch on the URL's tail, so their actions
 * are read off the registration calls in the routes directory and expanded.
 * A router mounted in neither composition is invisible to both lanes: the
 * replica-key router mounts only when `replicaKeys` is supplied, which
 * neither composition does.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, vi } from 'vitest'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { fc, fcTest } from '../shared/test-utils/fast-check.js'
import { RULES } from './_test-route-fuzz-daemon-rules.js'
import {
  assertLedger,
  fuzzRows,
  type Harness,
  type Override,
  registeredKeys,
  segmentArb,
  type Target,
} from './_test-route-fuzz-lane.js'
import { testDataLayout } from './routes/_test-helpers.js'

let tempDir = ''
// One data dir per seeded app: the legacy document store and its db handle
// are module-level and cache by path, so reusing a path across seeds would
// read the previous seed's cache over a fresh database.
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
const { createSelfHostStoreLocalModule } = await import('../di/store-local.module.js')
const { getDb } = await import('./store/db/index.js')
const { clearCache } = await import('./store/doc-cache.js')
const { _clearWorkspaceDocCacheForTests } = await import('./store/document-store.js')
const { seedWorkspaceRow } = await import('./routes/_test-helpers.js')
const { resetSyncStreamsForTests } = await import('./routes/sync-sse.js')

const TOKEN = 'fuzz-token'
// A handle per seed: the daemon's document store is module-level and keyed
// by workspace, and a checkpoint a previous app scheduled can land after
// its test ended — under a reused handle it would write that app's
// documents into the next seed's fresh data dir.
let seq = 0
const SPATIAL_PATH = 'board'
const MARKDOWN_PATH = 'notes/plan'
const OKF_NOTE = '---\ntype: note\ntags: [a]\n---\n# Plan\n\nA body.\n'

function runtimeOptions() {
  return {
    authMode: 'local-daemon' as const,
    token: TOKEN,
    touch: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    getStatus: () => ({
      ok: true,
      pid: 10,
      host: '127.0.0.1',
      port: 3099,
      baseUrl: 'http://127.0.0.1:3099',
      version: PACKAGE_VERSION,
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 100,
      idleForMs: 10,
      auth: { mode: 'local-token' as const, hasToken: true },
      storage: { dataDir: '/tmp', dataDirWritable: true },
      app: { served: true, buildPresent: false, ui: 'web-app' as const },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 0, ready: 0 },
    }),
  }
}

interface Seeded {
  app: ReturnType<typeof createApp>
  workspace: string
  spatialId: string
  markdownId: string
  trashedId: string
  versionId: string
}
const FILE_ID = 'img1'

/** A fresh daemon over a fresh data dir: one workspace, two documents, one saved version. */
async function seededApp(): Promise<Seeded> {
  dataDir = await mkdtemp(join(tempDir, 'data-'))
  clearCache()
  _clearWorkspaceDocCacheForTests()
  const workspace = `ws-${++seq}`
  await seedWorkspaceRow(dataDir, workspace)
  // The same SQLite store under `/api/v1` (serverDeps) and the legacy routes
  // (the module-level document store), as production composes it — the
  // default container is an in-memory store the legacy routes never see.
  const db = await getDb(dataDir)
  const serverDeps = resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, dataDir)))
  const app = createApp({ ...runtimeOptions(), serverDeps, dataLayout: testDataLayout() })
  const auth = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  const create = async (body: unknown) => {
    const res = await app.request(`/api/v1/workspaces/${workspace}/documents`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    })
    if (res.status !== 201) throw new Error(`seed failed: ${res.status} ${await res.text()}`)
    return ((await res.json()) as { documentId: string }).documentId
  }
  const spatialId = await create({ path: SPATIAL_PATH, kind: 'spatial' })
  const markdownId = await create({ path: MARKDOWN_PATH, kind: 'markdown', markdown: OKF_NOTE })
  const saved = await app.request(
    `/api/workspaces/${workspace}/documents/${SPATIAL_PATH}/versions`,
    { method: 'POST', headers: auth, body: JSON.stringify({ label: 'seed' }) },
  )
  if (saved.status !== 200 && saved.status !== 201) {
    throw new Error(`seed version failed: ${saved.status} ${await saved.text()}`)
  }
  const versionId = ((await saved.json()) as { version: { id: string } }).version.id
  // A document in the trash, so restore has something restorable.
  const trashedId = await create({ path: 'old', kind: 'spatial' })
  const deleted = await app.request(`/api/workspaces/${workspace}/documents/old`, {
    method: 'DELETE',
    headers: auth,
  })
  if (deleted.status >= 300) throw new Error(`seed delete failed: ${deleted.status}`)
  // A stored file, so the file read has bytes to answer with.
  const stored = await app.request(`/api/w/${workspace}/document/${SPATIAL_PATH}/file/${FILE_ID}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'image/png' },
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  })
  if (stored.status !== 204) throw new Error(`seed file failed: ${stored.status}`)
  return { app, workspace, spatialId, markdownId, trashedId, versionId }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
const workspaceArb = (seed: Seeded) =>
  fc.oneof(
    { weight: 6, arbitrary: fc.constant(seed.workspace) },
    { weight: 1, arbitrary: fc.constant('nowhere') },
    { weight: 1, arbitrary: segmentArb },
  )
const documentPathArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant(SPATIAL_PATH) },
  { weight: 3, arbitrary: fc.constant(MARKDOWN_PATH) },
  { weight: 1, arbitrary: fc.constant('missing') },
  // Whole segments, so a drawn `/` cannot make an empty one — that is a
  // path no route matches, answered by the framework rather than a route.
  { weight: 1, arbitrary: segmentArb.filter((s) => !s.includes('/')) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(segmentArb, segmentArb)
      .filter(([a, b]) => !a.includes('/') && !b.includes('/'))
      .map(([a, b]) => `${a}/${b}`),
  },
)
const NONCES = ['AAAAAAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'A'.repeat(43)]
const OKF_OR_NOT = fc.oneof(
  { weight: 3, arbitrary: fc.constant(OKF_NOTE) },
  { weight: 1, arbitrary: fc.string({ maxLength: 20 }) },
)

/** Ids and paths inside a body follow the seed; an export never writes outside the temp dir. */
function overrideFor(seed: Seeded): Override {
  return (path) => {
    if (path.endsWith('workspaceId')) return fc.constantFrom(seed.workspace, 'nowhere')
    if (path.endsWith('documentId')) return fc.constantFrom(seed.spatialId, seed.markdownId, 'nope')
    if (path.endsWith('.path') || path === 'path' || path.endsWith('doc')) {
      return fc.constantFrom(SPATIAL_PATH, MARKDOWN_PATH, 'fresh', 'notes/other')
    }
    if (path.endsWith('markdown')) return OKF_OR_NOT
    if (path.endsWith('nonce')) return fc.constantFrom(...NONCES)
    // Absent: the route refuses any explicit output path outside the
    // workspace's own exports directory before rendering, which would leave
    // the export rows refusing on nearly every draw and their ledger
    // starving (measured: one stress run in five). The default output path
    // is unique per export, so absent is also what lets the row answer more
    // than once.
    if (path.endsWith('outputPath')) return fc.constant(undefined)
    // A restore to a random target path is refused before it restores.
    if (path.endsWith('targetPath')) return fc.constant(undefined)
    return undefined
  }
}

/**
 * Fill a registered pattern's parameters and wildcard from the seed at real
 * weight. A quarter of draws are `happy`: every parameter names the seed, so
 * a row whose answer needs three seeded parameters at once (a restore: the
 * workspace, the one path with a version, that version's id) still answers
 * inside its draws instead of starving its ledger — measured, the
 * independent draws landed on all three about one time in fifteen.
 */
function pathArb(pattern: string, seed: Seeded): fc.Arbitrary<{ path: string; seeded: boolean }> {
  return fc.oneof(
    { weight: 1, arbitrary: fillPattern(pattern, seed, true) },
    { weight: 3, arbitrary: fillPattern(pattern, seed, false) },
  )
}

function fillPattern(
  pattern: string,
  seed: Seeded,
  happy: boolean,
): fc.Arbitrary<{ path: string; seeded: boolean }> {
  const segments = pattern.split('/')
  const parts = segments.map((segment): fc.Arbitrary<{ text: string; seeded: boolean }> => {
    if (happy) {
      const seededText = (): string | null => {
        if (segment === ':workspaceId') return seed.workspace
        if (segment === '*') return SPATIAL_PATH
        if (segment === ':documentId') return seed.trashedId
        if (segment === ':id') return seed.versionId
        if (segment === ':fileId') return FILE_ID
        return segment.startsWith(':') ? null : segment
      }
      const text = seededText()
      if (text !== null) return fc.constant({ text, seeded: true })
    }
    if (segment === ':workspaceId') {
      return workspaceArb(seed).map((w) => ({
        text: encodeURIComponent(w),
        seeded: w === seed.workspace,
      }))
    }
    if (segment === '*') {
      return documentPathArb.map((p) => ({
        text: p.split('/').map(encodeURIComponent).join('/'),
        seeded: p === SPATIAL_PATH || p === MARKDOWN_PATH,
      }))
    }
    if (segment === ':documentId') {
      // The trashed one at real weight: a restore is one-shot (the second
      // finds nothing restorable), so the first draws decide whether the
      // route ever answers.
      return fc
        .oneof(
          { weight: 4, arbitrary: fc.constant(seed.trashedId) },
          { weight: 1, arbitrary: fc.constantFrom(seed.spatialId, seed.markdownId, 'nope') },
        )
        .map((d) => ({ text: d, seeded: d !== 'nope' }))
    }
    if (segment === ':fileId') {
      return fc
        .oneof({ weight: 3, arbitrary: fc.constant(FILE_ID) }, { weight: 1, arbitrary: segmentArb })
        .map((f) => ({ text: encodeURIComponent(f), seeded: f === FILE_ID }))
    }
    if (segment === ':id') {
      return fc
        .oneof(
          { weight: 3, arbitrary: fc.constant(seed.versionId) },
          { weight: 1, arbitrary: segmentArb },
        )
        .map((id) => ({ text: encodeURIComponent(id), seeded: id === seed.versionId }))
    }
    if (segment.startsWith(':')) {
      return segmentArb.map((s) => ({ text: encodeURIComponent(s), seeded: false }))
    }
    return fc.constant({ text: segment, seeded: true })
  })
  return fc.tuple(...parts).map((filled) => ({
    path: filled.map((f) => f.text).join('/'),
    seeded: filled.every((f) => f.seeded),
  }))
}

const authArb = fc.oneof(
  { weight: 8, arbitrary: fc.constant(`Bearer ${TOKEN}`) },
  { weight: 1, arbitrary: fc.constant(undefined) },
)

// ---------------------------------------------------------------------------
// The local daemon: the routes both compositions share.
// ---------------------------------------------------------------------------
function daemonHarness(seed: Seeded): Harness {
  return {
    request: (path, init) => seed.app.request(path, init),
    target: (_key, pattern) =>
      fc.tuple(pathArb(pattern, seed), authArb).map(
        ([target, auth]): Target => ({
          path: target.path,
          headers: auth === undefined ? {} : { Authorization: auth },
        }),
      ),
    override: overrideFor(seed),
    dispose: async () => undefined,
  }
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------
const answered = new Map<string, number>()
let registered: string[] = []

describe('every daemon route answers or refuses with a reason, never a 5xx', () => {
  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-app-routes-fuzz-'))
    registered = registeredKeys((await seededApp()).app)
    resetSyncStreamsForTests()
  })

  afterAll(async () => {
    resetSyncStreamsForTests()
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  fcTest.prop([fc.constant(null)])(
    'every registered route has a rule, and every rule a route',
    () => {
      expect(registered.length).toBeGreaterThan(30)
      expect(registered).toEqual(Object.keys(RULES).sort())
    },
  )

  fuzzRows(RULES, answered, async () => daemonHarness(await seededApp()))

  afterAll(() => assertLedger(RULES, answered))
})
