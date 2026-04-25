import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LoroDoc, LoroMap } from 'loro-crdt'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(tempDir, 'data')
  },
  get DIST_APP_DIR() {
    return join(tempDir, 'dist')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

vi.mock('../daemon/ensure-daemon.js', () => ({
  ensureDaemon: vi.fn(async () => ({
    pid: 1,
    port: 3099,
    token: 'secret',
    version: '0.1.0',
    startedAt: '2026-04-24T00:00:00.000Z',
    baseUrl: 'http://daemon.test',
  })),
}))

const { createApp } = await import('./app.js')
const { createLocalTokenMcpHttpAuthStrategy } = await import('./security/mcp-auth.js')
const { clearCache } = await import('./store/doc-cache.js')

function createRuntimeOptions(
  token?: string,
  options?: Parameters<typeof createLocalTokenMcpHttpAuthStrategy>[0],
) {
  return {
    token,
    mcpAuth: options ? createLocalTokenMcpHttpAuthStrategy({ token, ...options }) : undefined,
    touch: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    getStatus: () => ({
      pid: 10,
      port: 3099,
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 100,
      idleForMs: 10,
      connectedClients: 0,
      readyClients: 0,
    }),
  }
}

describe('createApp daemon mutation auth', () => {
  const originalMcpHttpDebug = process.env.MCP_HTTP_DEBUG
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-app-test-'))
    await mkdir(join(tempDir, 'dist'), { recursive: true })
    await mkdir(join(tempDir, 'data'), { recursive: true })
    clearCache()
    await writeFile(
      join(tempDir, 'dist', 'index.html'),
      '<!DOCTYPE html><html><head><title>Whiteboard</title></head><body><div id="root"></div></body></html>',
    )
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    if (originalMcpHttpDebug === undefined) {
      delete process.env.MCP_HTTP_DEBUG
    } else {
      process.env.MCP_HTTP_DEBUG = originalMcpHttpDebug
    }
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
  })

  it('read-only routes stay public while mutation routes require bearer auth', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const listRes = await app.request('/api/sessions')
    expect(listRes.status).toBe(200)

    const debugRes = await app.request('/api/debug')
    expect(debugRes.status).toBe(401)

    const createRes = await app.request('/api/sessions/session1/canvases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'demo' }),
    })
    expect(createRes.status).toBe(401)

    const authedCreateRes = await app.request('/api/sessions/session1/canvases', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
      },
      body: JSON.stringify({ slug: 'demo' }),
    })
    expect(authedCreateRes.status).toBe(200)
    await expect(authedCreateRes.json()).resolves.toEqual({ slug: 'demo' })

    const authedDebugRes = await app.request('/api/debug', {
      headers: {
        Authorization: 'Bearer secret',
      },
    })
    expect(authedDebugRes.status).toBe(200)
  })

  it('injects runtime config with daemon token into served HTML', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    const res = await app.request('/canvas/session1/demo')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('window.__WHITEBOARD_RUNTIME_CONFIG__')
    expect(html).toContain('"daemonToken":"secret"')
  })

  it('rejects /mcp requests without bearer auth when a daemon token is configured', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'unauthed-test', version: '1.0.0' },
        },
      }),
    })

    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'unauthorized' },
      id: null,
    })
  })

  it('serves protected resource metadata and advertises it in WWW-Authenticate when configured', async () => {
    const app = createApp(
      createRuntimeOptions('secret', {
        protectedResourceMetadata: {
          authorizationServers: ['https://auth.example.com'],
          scopesSupported: ['canvas:read', 'canvas:write'],
        },
      }),
    )

    const metadataRes = await app.request(
      'http://127.0.0.1/.well-known/oauth-protected-resource/mcp',
    )
    expect(metadataRes.status).toBe(200)
    await expect(metadataRes.json()).resolves.toEqual({
      resource: 'http://127.0.0.1/mcp',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['canvas:read', 'canvas:write'],
    })

    const unauthorizedRes = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'unauthed-test', version: '1.0.0' },
        },
      }),
    })

    expect(unauthorizedRes.status).toBe(401)
    expect(unauthorizedRes.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"',
    )
  })

  it('rejects /mcp requests from disallowed browser origins', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'evil-origin-test', version: '1.0.0' },
        },
      }),
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'forbidden origin' },
      id: null,
    })
  })

  it('exposes an MCP Streamable HTTP endpoint for tool discovery', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    const snapshot = new LoroDoc().export({ mode: 'snapshot' })
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'http://daemon.test/api/runtime/touch') {
        return new Response(null, { status: 204 })
      }
      if (url === 'http://daemon.test/api/workspaces/M7lgM0WguBnkfP_1iOFtY/palette') {
        return new Response(JSON.stringify({ palette: {} }), { status: 200 })
      }
      if (url === 'http://daemon.test/api/canvas/M7lgM0WguBnkfP_1iOFtY/via-mcp/snapshot') {
        return new Response(snapshot, { status: 200 })
      }
      if (url === 'http://daemon.test/api/canvas/M7lgM0WguBnkfP_1iOFtY/via-mcp/update') {
        return new Response(null, { status: 204 })
      }
      if (/^http:\/\/daemon\.test\/api\/workspaces\/[^/]+\/canvases$/.test(url)) {
        return new Response(JSON.stringify({ slug: 'via-mcp' }), { status: 200 })
      }
      throw new Error(`Unexpected daemon fetch: ${url} ${init?.method ?? 'GET'}`)
    }) as typeof globalThis.fetch
    const client = new Client({ name: 'app-test-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers)
        headers.set('Authorization', 'Bearer secret')
        headers.set('Origin', 'http://127.0.0.1:6274')
        return app.request(input instanceof URL ? input.toString() : String(input), {
          ...init,
          headers,
        })
      },
    })

    await client.connect(transport)
    const tools = await client.listTools()
    const canvasCreateTool = tools.tools.find((tool) => tool.name === 'canvas_create')
    const annotateBatchTool = tools.tools.find((tool) => tool.name === 'annotate_batch')
    const createResult = await client.callTool({
      name: 'canvas_create',
      arguments: { slug: 'via-mcp', overwrite: true },
    })
    const annotateBatchResult = await client.callTool({
      name: 'annotate_batch',
      arguments: {
        canvasId: 'M7lgM0WguBnkfP_1iOFtY/via-mcp',
        annotations: [{ type: 'rectangle', target: { x: 100, y: 80 }, coords: 'absolute' }],
      },
    })

    expect(canvasCreateTool).toBeDefined()
    expect(annotateBatchTool).toBeDefined()
    expect(canvasCreateTool?.outputSchema).toBeDefined()
    expect(annotateBatchTool?.outputSchema).toBeDefined()
    expect(createResult.structuredContent).toMatchObject({
      id: expect.stringContaining('/via-mcp'),
      url: expect.stringContaining('/canvas/'),
    })
    expect(createResult.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify(createResult.structuredContent),
      },
    ])
    expect(annotateBatchResult.structuredContent).toMatchObject({
      elementIds: [expect.any(String)],
      annotations: [
        {
          type: 'rectangle',
          elementId: expect.any(String),
        },
      ],
      warnings: [],
      overlaps: [],
    })
    expect(annotateBatchResult.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify(annotateBatchResult.structuredContent),
      },
    ])
    await transport.close()
  })

  it('logs initialize capabilities and per-request timing when MCP_HTTP_DEBUG=1', async () => {
    process.env.MCP_HTTP_DEBUG = '1'
    const app = createApp(createRuntimeOptions())
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const client = new Client({ name: 'debug-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => app.request(input instanceof URL ? input.toString() : String(input), init),
    })

    await client.connect(transport)
    await client.listTools()
    await transport.close()

    expect(infoSpy).toHaveBeenCalledWith(
      '[mcp-http:init]',
      expect.objectContaining({
        clientInfo: { name: 'debug-client', version: '1.0.0' },
        capabilities: expect.any(Object),
      }),
    )
    expect(infoSpy).toHaveBeenCalledWith(
      '[mcp-http]',
      expect.objectContaining({
        path: '/mcp',
        jsonrpcMethod: 'initialize',
        status: 200,
        durationMs: expect.any(Number),
      }),
    )
    expect(infoSpy).toHaveBeenCalledWith(
      '[mcp-http]',
      expect.objectContaining({
        path: '/mcp',
        jsonrpcMethod: 'tools/list',
        status: 200,
        durationMs: expect.any(Number),
      }),
    )
    infoSpy.mockRestore()
  })

  it('protects newly added mutating /api routes by default', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    app.route(
      '/',
      new Hono()
        .get('/api/test-probe', (c) => c.json({ ok: true }))
        .post('/api/test-probe', (c) => c.json({ ok: true })),
    )

    const getRes = await app.request('/api/test-probe')
    expect(getRes.status).toBe(200)

    const unauthedPostRes = await app.request('/api/test-probe', {
      method: 'POST',
    })
    expect(unauthedPostRes.status).toBe(401)

    const authedPostRes = await app.request('/api/test-probe', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer secret',
      },
    })
    expect(authedPostRes.status).toBe(200)
    await expect(authedPostRes.json()).resolves.toEqual({ ok: true })
  })

  it('manual version save surfaces branch corruption from createApp.getHeadBranch as structured 500', async () => {
    const app = createApp(createRuntimeOptions())
    await mkdir(join(tempDir, 'data', 'session1', 'branches'), { recursive: true })
    await writeFile(
      join(tempDir, 'data', 'session1', 'branches', 'canvas-a.json'),
      'not-json',
    )

    const res = await app.request('/api/sessions/session1/canvases/canvas-a/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'v1' }),
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('canvas-a.json'),
    })
  })

  it('PUT /head surfaces current canvas corruption and preserves branch state', async () => {
    const { loadCanvasBranches } = await import('./store/branches-store.js')
    const app = createApp(createRuntimeOptions())

    await mkdir(join(tempDir, 'data', 'session1'), { recursive: true })
    await writeFile(
      join(tempDir, 'data', 'session1', 'canvas-a.loro'),
      new Uint8Array([1, 2, 3, 4]),
    )
    await app.request('/api/sessions/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const before = await loadCanvasBranches('session1', 'canvas-a')

    const res = await app.request('/api/sessions/session1/canvases/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature' }),
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('canvas-a.loro'),
    })
    await expect(loadCanvasBranches('session1', 'canvas-a')).resolves.toEqual(before)
  })

  it('PUT /head rejects invalid target tip and does not change head', async () => {
    const { saveCanvas } = await import('./store/canvas-store.js')
    const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')
    const app = createApp(createRuntimeOptions())

    await saveCanvas('session1', 'canvas-a', new LoroDoc(), { overwrite: true })
    await app.request('/api/sessions/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const state = await loadCanvasBranches('session1', 'canvas-a')
    const feature = state.branches.find((branch) => branch.name === 'feature')!
    feature.tipFrontiers = 'not-a-valid-tip'
    await saveCanvasBranches('session1', 'canvas-a', state)
    const before = await loadCanvasBranches('session1', 'canvas-a')

    const res = await app.request('/api/sessions/session1/canvases/canvas-a/head', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch: 'feature' }),
    })

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('checkout-target'),
    })
    await expect(loadCanvasBranches('session1', 'canvas-a')).resolves.toEqual(before)
  })

  it('merge preview rejects invalid source tip without mutating branches', async () => {
    const { saveCanvas } = await import('./store/canvas-store.js')
    const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')
    const app = createApp(createRuntimeOptions())

    await saveCanvas('session1', 'canvas-a', new LoroDoc(), { overwrite: true })
    await app.request('/api/sessions/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const state = await loadCanvasBranches('session1', 'canvas-a')
    const feature = state.branches.find((branch) => branch.name === 'feature')!
    feature.tipFrontiers = 'not-a-valid-tip'
    await saveCanvasBranches('session1', 'canvas-a', state)
    const before = await loadCanvasBranches('session1', 'canvas-a')

    const res = await app.request(
      '/api/sessions/session1/canvases/canvas-a/branches/feature/merge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: 'main', dryRun: true }),
      },
    )

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('feature'),
    })
    await expect(loadCanvasBranches('session1', 'canvas-a')).resolves.toEqual(before)
  })

  it('merge commit rejects invalid into tip without mutating live doc or branch tips', async () => {
    const { clearCache } = await import('./store/doc-cache.js')
    const { saveCanvas, loadCanvas } = await import('./store/canvas-store.js')
    const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')
    const app = createApp(createRuntimeOptions())

    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const element = list.insertContainer(0, new LoroMap())
    element.set('id', 'rect-1')
    element.set('type', 'rectangle')
    doc.commit()
    await saveCanvas('session1', 'canvas-a', doc, { overwrite: true })

    await app.request('/api/sessions/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const state = await loadCanvasBranches('session1', 'canvas-a')
    const main = state.branches.find((branch) => branch.name === 'main')!
    main.tipFrontiers = 'not-a-valid-tip'
    await saveCanvasBranches('session1', 'canvas-a', state)
    const before = await loadCanvasBranches('session1', 'canvas-a')

    const res = await app.request(
      '/api/sessions/session1/canvases/canvas-a/branches/feature/merge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: 'main' }),
      },
    )

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('main'),
    })
    await expect(loadCanvasBranches('session1', 'canvas-a')).resolves.toEqual(before)

    clearCache()
    const reloaded = await loadCanvas('session1', 'canvas-a')
    const elements = reloaded.getMovableList('elements').toJSON() as Array<{ id: string }>
    expect(elements.map((entry) => entry.id)).toEqual(['rect-1'])
  })

  it('merge pre-snapshot save carries system/merge operator', async () => {
    const { saveCanvas } = await import('./store/canvas-store.js')
    const { FileVersionStore } = await import('./store/version-store.js')
    const saveSpy = vi.spyOn(FileVersionStore.prototype, 'save')
    const app = createApp(createRuntimeOptions())

    const doc = new LoroDoc()
    await saveCanvas('session1', 'canvas-a', doc, { overwrite: true })

    await app.request('/api/sessions/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    const res = await app.request(
      '/api/sessions/session1/canvases/canvas-a/branches/feature/merge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: 'main' }),
      },
    )

    expect(res.status).toBe(200)
    const mergeSaveCall = saveSpy.mock.calls.find(
      (call) => call[0] === 'session1' &&
        call[1] === 'canvas-a' &&
        (call[3] as { label?: string } | undefined)?.label === 'before merge: feature → main',
    )
    expect(mergeSaveCall).toBeTruthy()
    expect(mergeSaveCall?.[3]).toMatchObject({
      auto: true,
      branchName: 'main',
      label: 'before merge: feature → main',
      operator: {
        kind: 'system',
        displayName: 'merge',
      },
    })
    expect((mergeSaveCall?.[3] as { operator?: { peerId?: string } } | undefined)?.operator?.peerId).toMatch(/\S+/)
  })
})
