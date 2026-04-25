import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
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
const { clearWorkspaceIdCache } = await import('./mcp/session-resolver.js')
const { PACKAGE_VERSION } = await import('../shared/package-version.js')

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
  const originalWhiteboardDebug = process.env.WHITEBOARD_DEBUG
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-app-test-'))
    await mkdir(join(tempDir, 'dist'), { recursive: true })
    await mkdir(join(tempDir, 'data'), { recursive: true })
    process.env.WHITEBOARD_DEBUG = '1'
    clearCache()
    clearWorkspaceIdCache()
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
    if (originalWhiteboardDebug === undefined) {
      delete process.env.WHITEBOARD_DEBUG
    } else {
      process.env.WHITEBOARD_DEBUG = originalWhiteboardDebug
    }
    await rm(tempDir, { recursive: true, force: true })
    clearCache()
    clearWorkspaceIdCache()
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

  it('adds baseline security headers to HTML responses', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('/canvas/session1/demo')

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
  })

  it('adds the same baseline security headers to API responses', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('/api/sessions')

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'")
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
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

  it('returns package-synced server metadata and tool capabilities on initialize', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        Origin: 'http://127.0.0.1:6274',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'init-test', version: '1.0.0' },
        },
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: {
          name: 'whiteboard',
          version: PACKAGE_VERSION,
        },
        capabilities: {
          tools: {
            listChanged: true,
          },
        },
      },
    })
  })

  it('echoes a supported client protocol version during initialize', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        Origin: 'http://127.0.0.1:6274',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'init-protocol-test', version: '1.0.0' },
        },
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
      },
    })
  })

  it('falls back to the sdk latest protocol version when the client asks for an unsupported version', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        Origin: 'http://127.0.0.1:6274',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '1999-01-01',
          capabilities: {},
          clientInfo: { name: 'init-protocol-fallback-test', version: '1.0.0' },
        },
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
      },
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

  it('exposes standalone help through MCP resources and prompts', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    const client = new Client({ name: 'app-help-client', version: '1.0.0' })
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
    const resources = await client.listResources()
    const prompts = await client.listPrompts()
    const helpResource = resources.resources.find(
      (resource) => resource.uri === 'whiteboard://help/getting-started',
    )
    const drawPrompt = prompts.prompts.find((prompt) => prompt.name === 'whiteboard.draw_diagram')

    expect(helpResource).toMatchObject({
      name: 'whiteboard-help',
      mimeType: 'text/markdown',
    })
    expect(drawPrompt).toMatchObject({
      name: 'whiteboard.draw_diagram',
    })

    const help = await client.readResource({ uri: 'whiteboard://help/getting-started' })
    const prompt = await client.getPrompt({
      name: 'whiteboard.draw_diagram',
      arguments: { goal: 'Summarize the payment flow' },
    })

    expect(help.contents).toEqual([
      expect.objectContaining({
        uri: 'whiteboard://help/getting-started',
        mimeType: 'text/markdown',
        text: expect.stringContaining('Start with `canvas_create`'),
      }),
    ])
    expect(prompt.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Summarize the payment flow'),
        }),
      }),
    ])

    await transport.close()
  })

  it('exposes dynamic installed-library and recent-canvas resources', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString()
      if (url === 'http://daemon.test/api/runtime/touch') {
        return new Response(null, { status: 204 })
      }
      if (/^http:\/\/daemon\.test\/api\/workspaces\/[^/]+\/libraries$/.test(url)) {
        return new Response(
          JSON.stringify({
            urls: ['https://libraries.example.com/architecture.excalidrawlib'],
          }),
          { status: 200 },
        )
      }
      if (url === 'http://daemon.test/api/workspaces') {
        return new Response(
          JSON.stringify({
            workspaces: [
              {
                workspaceId: 'M7lgM0WguBnkfP_1iOFtY',
                sessionId: 'M7lgM0WguBnkfP_1iOFtY',
                daemonAlive: true,
              },
            ],
          }),
          { status: 200 },
        )
      }
      if (/^http:\/\/daemon\.test\/api\/workspaces\/[^/]+\/canvases$/.test(url)) {
        return new Response(
          JSON.stringify({
            canvases: [
              { slug: 'payments-flow', updatedAt: '2026-04-25T10:30:00.000Z' },
              { slug: 'system-overview', updatedAt: '2026-04-24T08:15:00.000Z' },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected daemon fetch: ${url} ${init?.method ?? 'GET'}`)
    }) as typeof globalThis.fetch
    const client = new Client({ name: 'app-dynamic-resource-client', version: '1.0.0' })
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
    const resources = await client.listResources()

    expect(resources.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uri: 'whiteboard://state/libraries/installed',
          name: 'whiteboard-installed-libraries',
        }),
        expect.objectContaining({
          uri: 'whiteboard://state/canvases/recent',
          name: 'whiteboard-recent-canvases',
        }),
      ]),
    )

    const installedLibraries = await client.readResource({
      uri: 'whiteboard://state/libraries/installed',
    })
    const recentCanvases = await client.readResource({
      uri: 'whiteboard://state/canvases/recent',
    })

    expect(installedLibraries.contents).toEqual([
      expect.objectContaining({
        uri: 'whiteboard://state/libraries/installed',
        text: expect.stringContaining('https://libraries.example.com/architecture.excalidrawlib'),
      }),
    ])
    expect(recentCanvases.contents).toEqual([
      expect.objectContaining({
        uri: 'whiteboard://state/canvases/recent',
        text: expect.stringContaining('/payments-flow'),
      }),
    ])
    expect(recentCanvases.contents[0]?.text).toContain('system-overview')

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
    expect(infoSpy).toHaveBeenCalledWith(
      '[mcp-http:construct]',
      expect.objectContaining({ durationMs: expect.any(Number) }),
    )
    expect(infoSpy).toHaveBeenCalledWith(
      '[mcp-http:destruct]',
      expect.objectContaining({ durationMs: expect.any(Number) }),
    )
    infoSpy.mockRestore()
  })

  it('handles concurrent /mcp initialize requests without racing the workspace marker file', async () => {
    const app = createApp(createRuntimeOptions())
    const dataDir = join(tempDir, 'data')

    const sendInitialize = async (id: number): Promise<Response> =>
      app.request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: `load-${id}`, version: '1.0.0' },
          },
        }),
      })

    const concurrency = 32
    const responses = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => sendInitialize(i)),
    )
    expect(responses).toHaveLength(concurrency)
    for (const res of responses) {
      expect(res.status).toBe(200)
      const body = (await res.json()) as { result?: { protocolVersion?: string } }
      expect(body.result?.protocolVersion).toBeDefined()
    }

    const { readFile: readFileFs } = await import('node:fs/promises')
    const current = (await readFileFs(join(dataDir, '.current-workspace'), 'utf-8')).trim()
    const latest = (await readFileFs(join(dataDir, '.latest-session'), 'utf-8')).trim()
    expect(current).toMatch(/^[A-Za-z0-9_-]{21}$/)
    expect(latest).toBe(current)
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
