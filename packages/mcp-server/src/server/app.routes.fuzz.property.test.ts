/**
 * Every HTTP route the daemon registers, requested with what its own input
 * schema admits — and with what it does not.
 *
 * server-core's `create-server.routes.fuzz` covers the `/api/v1` surface it
 * owns; this is the same question asked of everything else `createApp`
 * mounts: the legacy `/api/workspaces` and `/api/w` document routes, sync,
 * runtime, fonts, files, export, viewport, debug, ws-ticket and the OAuth
 * metadata. A route may answer (2xx, or 501 saying the composition lacks the
 * feature), or refuse a request it understood (4xx with a JSON body naming
 * why) — never a 5xx, and never a body the browser client cannot read.
 *
 * Routes are read off `app.routes`, so one added without a rule here fails.
 * The three wildcard patterns dispatch on the URL's tail, so their actions
 * are read off the registration calls in the routes directory and expanded.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canvasExistsResponseSchema,
  createDocumentRequestSchema,
  createDocumentResponseSchema,
  createWorkspaceRequestSchema,
  deleteDocumentResponseSchema,
  listDocumentsResponseSchema,
  listTrashResponseSchema,
  listVersionsResponseSchema,
  listWorkspacesResponseSchema,
  optimizeAllDocumentsResponseSchema,
  pruneSandwichedVersionsResponseSchema,
  renameDocumentPathRequestSchema,
  renameDocumentPathResponseSchema,
  renameWorkspaceRequestSchema,
  restoreTrashResponseSchema,
  restoreVersionRequestSchema,
  saveVersionRequestSchema,
  saveVersionResponseSchema,
  setNameRequestSchema,
  setPinnedRequestSchema,
  updateDocumentResponseSchema,
  versionDocumentResponseSchema,
  workspaceNamesSchema,
  workspaceSummarySchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { listFontsResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import {
  daemonPingResponseSchema,
  runtimeStatusResponseSchema,
  runtimeVerifyRequestSchema,
  runtimeVerifyResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { viewportRequestParamsSchema } from '@kamiazya/whiteboard-daemon-client/ws-messages'
import { arbitraryForSchema } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { afterAll, beforeAll, describe, expect, vi } from 'vitest'
import type { z } from 'zod'
import { clientCountResponseSchema } from '../shared/api-contracts/document-runtime.js'
import { exportRequestSchema, exportResponseSchema } from '../shared/api-contracts/export.js'
import { exportSvgRequestSchema } from '../shared/api-contracts/export-svg.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { fc, fcTest, withDefaults } from '../shared/test-utils/fast-check.js'

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
const { createStoreLocalModule } = await import('../di/store-local.module.js')
const { getDb } = await import('./store/db/index.js')
const { clearCache } = await import('./store/doc-cache.js')
const { _clearWorkspaceDocCacheForTests } = await import('./store/document-store.js')
const { seedWorkspaceRow } = await import('./routes/_test-helpers.js')
const { resetSyncStreamsForTests } = await import('./routes/sync-sse.js')
const { syncSubscribeRequestSchema, syncClientMessageRequestSchema } = await import(
  './routes/sync-sse.js'
)

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
  const serverDeps = resolveServerDeps(
    createContainer(createStoreLocalModule({ db, blobDir: dataDir })),
  )
  const app = createApp({ ...runtimeOptions(), serverDeps })
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
// What each route may do, keyed by `METHOD pattern` as the app registers it
// (wildcards expanded with their action). `answers` is what a 2xx carries;
// `refuses-only:` says why the seeding cannot reach one and is checked to
// still be true; `skip:` says why the lane does not request it at all.
// ---------------------------------------------------------------------------
type Rule =
  | {
      readonly answers: 'json' | 'bytes' | 'none'
      readonly body?: z.ZodTypeAny
      readonly raw?: true
      /** What raw bytes are sent as; the file route stores images only. */
      readonly contentType?: string
      /** Fewer draws for a route whose every answer is a real render. */
      readonly runs?: number
      /**
       * The schema a typed client reads a 2xx with. A body that fails it is
       * drift between what the route emits and what its readers expect —
       * the handler is typed, but nothing parses on the way out. Absent
       * where no client contract exists for the answer.
       */
      readonly response?: z.ZodTypeAny
    }
  | { readonly refusesOnly: string; readonly body?: z.ZodTypeAny }
  | { readonly skip: string }

const RULES: Record<string, Rule> = {
  'GET /api/workspaces': { answers: 'json', response: listWorkspacesResponseSchema },
  'POST /api/workspaces': {
    answers: 'json',
    body: createWorkspaceRequestSchema,
    response: workspaceSummarySchema,
  },
  'PATCH /api/workspaces/:workspaceId': {
    answers: 'json',
    body: renameWorkspaceRequestSchema,
    response: workspaceSummarySchema,
  },
  'GET /api/workspaces/:workspaceId/documents': {
    answers: 'json',
    response: listDocumentsResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/documents': {
    answers: 'json',
    body: createDocumentRequestSchema,
    response: createDocumentResponseSchema,
  },
  'GET /api/workspaces/:workspaceId/names': { answers: 'json', response: workspaceNamesSchema },
  'PUT /api/workspaces/:workspaceId/name': { answers: 'json', body: setNameRequestSchema },
  'GET /api/workspaces/:workspaceId/trash': { answers: 'json', response: listTrashResponseSchema },
  'POST /api/workspaces/:workspaceId/trash/:documentId/restore': {
    answers: 'json',
    response: restoreTrashResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/versions/prune-sandwiched': {
    answers: 'json',
    response: pruneSandwichedVersionsResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/documents/optimize-all': {
    answers: 'json',
    response: optimizeAllDocumentsResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/files/purge-dangling': { answers: 'json' },
  'GET /api/workspaces/:workspaceId/documents/*/versions': {
    answers: 'json',
    response: listVersionsResponseSchema,
  },
  'GET /api/workspaces/:workspaceId/documents/*/versions/:id/document': {
    answers: 'json',
    response: versionDocumentResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/documents/*/versions': {
    answers: 'json',
    body: saveVersionRequestSchema,
    response: saveVersionResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/documents/*/versions/:id/restore': {
    answers: 'json',
    body: restoreVersionRequestSchema,
  },
  'PUT /api/workspaces/:workspaceId/documents/*/name': {
    answers: 'json',
    body: setNameRequestSchema,
  },
  'PUT /api/workspaces/:workspaceId/documents/*/pin': {
    answers: 'json',
    body: setPinnedRequestSchema,
  },
  'PUT /api/workspaces/:workspaceId/documents/*/path': {
    answers: 'json',
    body: renameDocumentPathRequestSchema,
    response: renameDocumentPathResponseSchema,
  },
  'POST /api/workspaces/:workspaceId/documents/*/compact': { answers: 'json' },
  'DELETE /api/workspaces/:workspaceId/documents/*': {
    answers: 'json',
    response: deleteDocumentResponseSchema,
  },
  'GET /api/w/:workspaceId/document/*/exists': {
    answers: 'json',
    response: canvasExistsResponseSchema,
  },
  'GET /api/w/:workspaceId/document/*/snapshot': { answers: 'bytes' },
  'GET /api/w/:workspaceId/document/*/client-count': {
    answers: 'json',
    response: clientCountResponseSchema,
  },
  'POST /api/w/:workspaceId/document/*/viewport': {
    // No browser is connected, so every well-formed request is a 503.
    refusesOnly: 'needs a connected WebSocket client to apply the viewport',
    body: viewportRequestParamsSchema,
  },
  'POST /api/w/:workspaceId/document/*/update': {
    answers: 'json',
    raw: true,
    response: updateDocumentResponseSchema,
  },
  'POST /api/w/:workspaceId/document/*/export': {
    answers: 'json',
    body: exportRequestSchema,
    runs: 24,
    response: exportResponseSchema,
  },
  'POST /api/w/:workspaceId/document/*/export-svg': {
    answers: 'json',
    body: exportSvgRequestSchema,
    runs: 24,
    response: exportResponseSchema,
  },
  'PUT /api/w/:workspaceId/document/*/file/:fileId': {
    answers: 'none',
    raw: true,
    contentType: 'image/png',
  },
  'GET /api/w/:workspaceId/document/*/file/:fileId': { answers: 'bytes' },
  'GET /api/w/:workspaceId/workspace-document/snapshot': { answers: 'bytes' },
  'POST /api/w/:workspaceId/workspace-document/update': {
    answers: 'json',
    raw: true,
    response: updateDocumentResponseSchema,
  },
  'GET /api/sync/stream': { skip: 'holds the response open until the client goes away' },
  'POST /api/sync/subscribe': {
    refusesOnly: 'needs the stream id of an open /api/sync/stream, which this lane never opens',
    body: syncSubscribeRequestSchema,
  },
  'POST /api/sync/message': {
    refusesOnly: 'needs the stream id of an open /api/sync/stream, which this lane never opens',
    body: syncClientMessageRequestSchema,
  },
  'GET /api/runtime/ping': { answers: 'json', response: daemonPingResponseSchema },
  'POST /api/runtime/verify': {
    answers: 'json',
    body: runtimeVerifyRequestSchema,
    response: runtimeVerifyResponseSchema,
  },
  'GET /api/runtime/status': { answers: 'json', response: runtimeStatusResponseSchema },
  'POST /api/runtime/touch': { answers: 'json' },
  'POST /api/runtime/shutdown': { answers: 'json' },
  'GET /api/runtime/storage': { answers: 'json' },
  'POST /api/runtime/logs/prune': { answers: 'json' },
  'GET /api/fonts': { answers: 'json', response: listFontsResponseSchema },
  'GET /api/fonts/:id/file': { refusesOnly: 'a fresh data dir has no installed font' },
  'POST /api/fonts/:id/install': { skip: 'downloads the font from the network' },
  'POST /api/ws-ticket': {
    refusesOnly: 'no OAuth registry is configured, so no grant can be presented',
  },
  // RFC 9728 discovery: with no OAuth resource metadata the answer is a
  // bare 404, which is what a discovery client expects and not a refusal
  // this lane's JSON contract covers.
  'GET /.well-known/oauth-protected-resource': {
    skip: 'RFC 9728 discovery answers a bare 404 when no OAuth metadata exists',
  },
  'GET /.well-known/oauth-protected-resource/mcp': {
    skip: 'RFC 9728 discovery answers a bare 404 when no OAuth metadata exists',
  },
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
/** A segment the URL parser leaves alone (`.` and `..` resolve away before any route sees them). */
const reachesRoute = (segment: string) =>
  new URL(`http://fuzz/${encodeURIComponent(segment)}`).pathname ===
  `/${encodeURIComponent(segment)}`
const segmentArb = fc.string({ minLength: 1, maxLength: 8 }).filter(reachesRoute)

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
/** A real Loro update — one map write from a fresh peer — so a raw-bytes route can answer. */
const loroUpdateArb = fc.string({ maxLength: 6 }).map((value) => {
  const doc = new LoroDoc()
  const from = doc.version()
  doc.getMap('fuzz').set('k', value)
  doc.commit()
  return doc.export({ mode: 'update', from })
})
const NONCES = ['AAAAAAAAAAAAAAAAAAAAAA', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'A'.repeat(43)]
const OKF_OR_NOT = fc.oneof(
  { weight: 3, arbitrary: fc.constant(OKF_NOTE) },
  { weight: 1, arbitrary: fc.string({ maxLength: 20 }) },
)

/** Ids and paths inside a body follow the seed; an export never writes outside the temp dir. */
function overrideFor(seed: Seeded) {
  return (path: string, _schema: z.ZodTypeAny): fc.Arbitrary<unknown> | undefined => {
    if (path.endsWith('workspaceId')) return fc.constantFrom(seed.workspace, 'nowhere')
    if (path.endsWith('documentId')) return fc.constantFrom(seed.spatialId, seed.markdownId, 'nope')
    if (path.endsWith('.path') || path === 'path' || path.endsWith('doc')) {
      return fc.constantFrom(SPATIAL_PATH, MARKDOWN_PATH, 'fresh', 'notes/other')
    }
    if (path.endsWith('markdown')) return OKF_OR_NOT
    if (path.endsWith('nonce')) return fc.constantFrom(...NONCES)
    if (path.endsWith('outputPath')) {
      return fc.constantFrom(join(tempDir, 'exports', 'a.png'), join(tempDir, 'exports', 'b.svg'))
    }
    return undefined
  }
}

type Body =
  | { readonly kind: 'json'; readonly json: unknown }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }

function bodyArb(method: string, rule: Rule, seed: Seeded): fc.Arbitrary<Body | undefined> {
  if (method === 'GET') return fc.constant(undefined)
  const schema = 'body' in rule ? rule.body : undefined
  const raw = 'raw' in rule && rule.raw === true
  const arms: fc.WeightedArbitrary<Body | undefined>[] = [
    {
      weight: 1,
      arbitrary: fc.jsonValue({ maxDepth: 2 }).map((json): Body => ({ kind: 'json', json })),
    },
    {
      weight: 1,
      arbitrary: fc.string({ maxLength: 12 }).map((text): Body => ({ kind: 'text', text })),
    },
    { weight: 1, arbitrary: fc.constant(undefined) },
  ]
  if (schema !== undefined) {
    arms.push({
      weight: 5,
      arbitrary: arbitraryForSchema(schema, { override: overrideFor(seed) }).map(
        (json): Body => ({ kind: 'json', json }),
      ),
    })
  }
  if (raw) {
    arms.push(
      {
        weight: 2,
        arbitrary: fc
          .uint8Array({ maxLength: 64 })
          .map((bytes): Body => ({ kind: 'bytes', bytes })),
      },
      { weight: 3, arbitrary: loroUpdateArb.map((bytes): Body => ({ kind: 'bytes', bytes })) },
    )
  }
  return fc.oneof(...arms)
}

/** Fill a registered pattern's parameters and wildcard from the seed at real weight. */
function pathArb(pattern: string, seed: Seeded): fc.Arbitrary<{ path: string; seeded: boolean }> {
  const segments = pattern.split('/')
  const parts = segments.map((segment): fc.Arbitrary<{ text: string; seeded: boolean }> => {
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
// The registered surface: plain routes off `app.routes`, wildcard actions off
// the registration calls in the source.
// ---------------------------------------------------------------------------
const ROUTES_DIR = join(import.meta.dirname, 'routes')

function scanWildcardActions(): string[] {
  const keys = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        const source = readFileSync(full, 'utf8')
        for (const m of source.matchAll(/onDocumentAction\(\s*app,\s*'(\w+)',\s*'([\w-]+)'/g)) {
          keys.add(`${m[1]!.toUpperCase()} /api/w/:workspaceId/document/*/${m[2]}`)
        }
        for (const m of source.matchAll(/onDocumentFile\(\s*app,\s*'(\w+)'/g)) {
          keys.add(`${m[1]!.toUpperCase()} /api/w/:workspaceId/document/*/file/:fileId`)
        }
        for (const m of source.matchAll(/onDocumentsRoute\(\s*app,\s*'(\w+)',\s*\[([^\]]*)\]/g)) {
          const suffix = [...m[2]!.matchAll(/'([^']+)'/g)].map((s) => s[1]).join('/')
          const tail = suffix === '' ? '' : `/${suffix}`
          keys.add(`${m[1]!.toUpperCase()} /api/workspaces/:workspaceId/documents/*${tail}`)
        }
      }
    }
  }
  walk(ROUTES_DIR)
  return [...keys]
}

const WILDCARDS = new Set([
  '/api/w/:workspaceId/document/*',
  '/api/workspaces/:workspaceId/documents/*',
])

function registeredKeys(app: ReturnType<typeof createApp>): string[] {
  const keys = new Set<string>()
  for (const route of app.routes) {
    if (route.method === 'ALL') continue
    if (route.path === '*' || route.path === '/*') continue
    // server-core's mount, fuzzed by its own lane against its own seed.
    if (route.path.startsWith('/api/v1/')) continue
    if (WILDCARDS.has(route.path)) continue
    keys.add(`${route.method} ${route.path}`)
  }
  for (const key of scanWildcardActions()) keys.add(key)
  return [...keys].sort()
}

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

  for (const [key, rule] of Object.entries(RULES)) {
    if ('skip' in rule) continue
    const [method, pattern] = key.split(' ') as [string, string]
    // A ceiling sized on a measurement, not a delay: 40 requests take 0.2-2s
    // on this container, and a render route's 24 draws took 19-21s — past
    // the project's 10s default, and a timed-out test keeps rendering into
    // the next test's fresh database, which then answers SQLITE_BUSY.
    const ceilingMs = 'runs' in rule && rule.runs !== undefined ? 90_000 : 30_000
    fcTest.prop([fc.constant(null)], withDefaults({ numRuns: 1 }))(
      `${key}`,
      async () => {
        const seed = await seededApp()
        const requestArb = fc.record({
          target: pathArb(pattern, seed),
          body: bodyArb(method, rule, seed),
          auth: authArb,
        })
        await fc.assert(
          fc.asyncProperty(requestArb, async ({ target, body, auth }) => {
            const headers: Record<string, string> = {}
            if (auth !== undefined) headers.Authorization = auth
            const init: RequestInit = { method, headers }
            if (body?.kind === 'json') {
              init.body = JSON.stringify(body.json)
              headers['content-type'] = 'application/json'
            } else if (body?.kind === 'text') {
              init.body = body.text
              headers['content-type'] = 'application/json'
            } else if (body?.kind === 'bytes') {
              init.body = body.bytes
              headers['content-type'] =
                'contentType' in rule && rule.contentType !== undefined
                  ? rule.contentType
                  : 'application/octet-stream'
            }
            const res = await seed.app.request(target.path, init)
            const contentType = res.headers.get('content-type') ?? ''
            const text = contentType.includes('json') || !contentType ? await res.text() : ''
            const detail = `${method} ${target.path} ${init.body instanceof Uint8Array ? '<bytes>' : (init.body ?? '')} -> ${res.status} ${contentType} ${text.slice(0, 200)}`
            // 501 (the composition lacks the feature) and 503 (no browser is
            // connected, the GC scan is incomplete) are declared refusals with
            // a JSON reason; anything else at or above 500 is a stack trace.
            expect(res.status === 501 || res.status === 503 || res.status < 500, detail).toBe(true)
            if (contentType.includes('json')) {
              expect(() => JSON.parse(text), detail).not.toThrow()
            } else if (res.status === 204) {
              expect('answers' in rule && rule.answers === 'none', detail).toBe(true)
            } else if (res.status < 300) {
              expect('answers' in rule && rule.answers === 'bytes', detail).toBe(true)
            } else {
              // A refusal the client cannot read.
              expect.fail(detail)
            }
            if (res.status < 300) {
              answered.set(key, (answered.get(key) ?? 0) + 1)
              if (
                'response' in rule &&
                rule.response !== undefined &&
                contentType.includes('json')
              ) {
                const read = rule.response.safeParse(JSON.parse(text))
                expect(read.success, `${detail}\n${JSON.stringify(read.error?.issues)}`).toBe(true)
              }
            }
          }),
          withDefaults({ numRuns: 'runs' in rule && rule.runs !== undefined ? rule.runs : 40 }),
        )
      },
      ceilingMs,
    )
  }

  afterAll(() => {
    const silent: string[] = []
    const loud: string[] = []
    for (const [key, rule] of Object.entries(RULES)) {
      const count = answered.get(key) ?? 0
      if ('answers' in rule && count === 0) silent.push(key)
      if ('refusesOnly' in rule && count > 0) loud.push(key)
    }
    expect(
      silent,
      `routes this lane never got a 2xx from: ${JSON.stringify([...answered])}`,
    ).toEqual([])
    expect(loud, 'routes marked refuses-only that answered').toEqual([])
  })
})
