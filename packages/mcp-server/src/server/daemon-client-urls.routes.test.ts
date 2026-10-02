import { join } from 'node:path'
import * as daemonUrls from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import * as documentUrls from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import {
  DOCUMENT_API_ACTIONS,
  type DocumentApiAction,
  WORKSPACE_DOCUMENT_API_ACTIONS,
  type WorkspaceDocumentApiAction,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-client-urls-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createApp } = await import('./app.js')
const { createContainer, resolveServerDeps } = await import('../di/container.js')
const { clearCache } = await import('./store/doc-cache.js')
const { PACKAGE_VERSION } = await import('../shared/package-version.js')

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
  exists: 'GET',
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
  ],
  workspaceDocumentApiUrl: WORKSPACE_DOCUMENT_API_ACTIONS.map((action) => ({
    label: action,
    method: WORKSPACE_DOCUMENT_ACTION_METHODS[action],
    url: documentUrls.workspaceDocumentApiUrl(WS, action),
  })),
  workspacesApiUrl: [{ label: 'list', method: 'GET', url: daemonUrls.workspacesApiUrl() }],
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
  logsPruneApiUrl: [{ label: 'prune', method: 'POST', url: daemonUrls.logsPruneApiUrl() }],
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

/** Every builder the two modules export; the `ApiUrl` suffix is the convention that names one. */
const BUILDERS = Object.entries({ ...documentUrls, ...daemonUrls })
  .filter(([name, value]) => name.endsWith('ApiUrl') && typeof value === 'function')
  .map(([name]) => name)

describe('daemon client URLs reach a route', () => {
  beforeEach(() => {
    clearCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has a sample for exactly the builders the modules export', () => {
    // A floor, so an enumeration that found nothing cannot pass.
    expect(BUILDERS.length).toBeGreaterThan(25)
    expect([...BUILDERS].sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  const rows = Object.entries(SAMPLES).flatMap(([builder, samples]) =>
    samples.map((sample) => ({ builder, ...sample })),
  )

  it.each(rows)('$builder $label ($method) is served by a route', async ({ method, url }) => {
    const app = createApp({
      authMode: 'local-daemon',
      token: TOKEN,
      serverDeps: resolveServerDeps(createContainer()),
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
    const res = await app.request(url, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
    })
    // Hono's own unmatched answer is plain text; every route that refuses a
    // request it understood says so in JSON.
    const unmatched =
      res.status === 404 && (res.headers.get('content-type') ?? '').startsWith('text/plain')
    expect(unmatched, `${method} ${url} -> ${res.status}`).toBe(false)
  })
})
