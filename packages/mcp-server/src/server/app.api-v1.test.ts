/**
 * The daemon mounts server-core's /api/v1 document surface when given
 * ServerDeps, so the workspace tree (documentId + path world) is reachable
 * over HTTP and not only through the MCP tools createServer(deps) also
 * registers. The mount sits under the same /api/* daemon auth as every
 * other API route.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { testDataLayout, withTempDataDir } from './routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-app-v1-test-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { createApp } = await import('./app.js')
const { createContainer, resolveServerDeps } = await import('../di/container.js')
const { PACKAGE_VERSION } = await import('../shared/package-version.js')

function createRuntimeOptions(token?: string) {
  return {
    authMode: 'local-daemon' as const,
    token,
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
      auth: { mode: 'local-token' as const, hasToken: Boolean(token) },
      storage: { dataDir: '/tmp', dataDirWritable: true },
      app: { served: true, buildPresent: false, ui: 'web-app' as const },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 0, ready: 0 },
    }),
  }
}

describe('createApp /api/v1 document mount', () => {
  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
    await writeFile(
      join(tmp.dir, 'web-app', 'index.html'),
      '<!DOCTYPE html><html><head><title>Whiteboard</title></head><body><div id="root"></div></body></html>',
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serves the v1 canvas list behind daemon auth when serverDeps are provided', async () => {
    const deps = resolveServerDeps(createContainer(storeMemoryModule))
    const app = createApp({
      ...createRuntimeOptions('secret'),
      serverDeps: deps,
      dataLayout: testDataLayout(),
    })

    const unauthed = await app.request('/api/v1/workspaces/default/documents')
    expect(unauthed.status).toBe(401)

    // The daemon auth check runs ahead of the workspace-existence check, so
    // an authed request against a never-created workspace 404s rather than
    // 200-empty — list and create agree about workspace existence.
    const res = await app.request('/api/v1/workspaces/default/documents', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(404)
  })

  it('round-trips create → list with the document path', async () => {
    const deps = resolveServerDeps(createContainer(storeMemoryModule))
    const app = createApp({
      ...createRuntimeOptions('secret'),
      serverDeps: deps,
      dataLayout: testDataLayout(),
    })

    const createRes = await app.request('/api/v1/workspaces/default/documents', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'notes', kind: 'spatial', createWorkspace: true }),
    })
    expect(createRes.status).toBe(201)

    const listRes = await app.request('/api/v1/workspaces/default/documents', {
      headers: { Authorization: 'Bearer secret' },
    })
    const body = (await listRes.json()) as { documents: { path: string }[] }
    expect(body.documents.map((c) => c.path)).toEqual(['notes'])
  })

  // The web app creates a markdown document with no body and reads it back
  // through `/okf`: the type it shows must be a markdown document's own.
  it('reads a markdown document created with no body back as a note', async () => {
    const deps = resolveServerDeps(createContainer(storeMemoryModule))
    const app = createApp({
      ...createRuntimeOptions('secret'),
      serverDeps: deps,
      dataLayout: testDataLayout(),
    })
    const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }

    const createRes = await app.request('/api/v1/workspaces/default/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: 'note1', kind: 'markdown', createWorkspace: true }),
    })
    expect(createRes.status).toBe(201)
    const { documentId } = (await createRes.json()) as { documentId: string }

    const okfRes = await app.request(`/api/v1/workspaces/default/documents/${documentId}/okf`, {
      headers,
    })
    expect(okfRes.status).toBe(200)
    const okf = (await okfRes.json()) as { markdown: string; frontmatter: { type: string } }
    expect(okf.frontmatter.type).toBe('note')
    expect(okf.markdown).toContain('type: note')
  })
})
