/**
 * The daemon mounts server-core's /api/v1 OpenCanvas surface when given
 * ServerDeps. Until this slice, createServer(deps) was only used for its
 * MCP tools — the HTTP app it returns was never mounted, so the workspace
 * tree (canvasId + alias world) was unreachable over HTTP even though the
 * routes existed. The mount sits under the same /api/* daemon auth as every
 * other API route.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'

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

describe('createApp /api/v1 OpenCanvas mount', () => {
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
    const deps = resolveServerDeps(createContainer())
    const app = createApp({ ...createRuntimeOptions('secret'), serverDeps: deps })

    const unauthed = await app.request('/api/v1/workspaces/default/canvases')
    expect(unauthed.status).toBe(401)

    const res = await app.request('/api/v1/workspaces/default/canvases', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ canvases: [] })
  })

  it('round-trips create → list with the derived alias', async () => {
    const deps = resolveServerDeps(createContainer())
    const app = createApp({ ...createRuntimeOptions('secret'), serverDeps: deps })

    const createRes = await app.request('/api/v1/workspaces/default/canvases', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ segment: 'notes' }),
    })
    expect(createRes.status).toBe(201)

    const listRes = await app.request('/api/v1/workspaces/default/canvases', {
      headers: { Authorization: 'Bearer secret' },
    })
    const body = (await listRes.json()) as { canvases: { segment: string; alias: string }[] }
    expect(body.canvases.map((c) => ({ segment: c.segment, alias: c.alias }))).toEqual([
      { segment: 'notes', alias: 'notes' },
    ])
  })

  it('leaves /api/v1 unmounted (404) when no serverDeps are supplied', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    const res = await app.request('/api/v1/workspaces/default/canvases', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(res.status).toBe(404)
  })
})
