import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempDataDir } from './routes/_test-helpers.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js'
import { Hono } from 'hono'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tmp = withTempDataDir('whiteboard-app-test-')

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
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
    authMode: 'local-daemon' as const,
    token,
    mcpAuth: options ? createLocalTokenMcpHttpAuthStrategy({ token, ...options }) : undefined,
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
      auth: { mode: 'local-token', hasToken: Boolean(token) },
      storage: { dataDir: '/tmp', dataDirWritable: true },
      app: { served: true, buildPresent: false, ui: 'web-app' },
      mcp: { httpEnabled: true, endpoint: 'http://127.0.0.1:3099/mcp' },
      clients: { connected: 0, ready: 0 },
    }),
  }
}

describe('createApp daemon mutation auth', () => {
  const originalMcpHttpDebug = process.env.MCP_HTTP_DEBUG
  const originalWhiteboardDebug = process.env.WHITEBOARD_DEBUG
  const originalFetch = globalThis.fetch

  beforeEach(async () => {
    await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
    await mkdir(join(tmp.dir, 'data'), { recursive: true })
    process.env.WHITEBOARD_DEBUG = '1'
    clearCache()
    clearWorkspaceIdCache()
    await writeFile(
      join(tmp.dir, 'web-app', 'index.html'),
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
    clearCache()
    clearWorkspaceIdCache()
  })

  it('read-only routes stay public while mutation routes require bearer auth', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const listRes = await app.request('/api/workspaces')
    expect(listRes.status).toBe(200)

    const debugRes = await app.request('/api/debug')
    expect(debugRes.status).toBe(401)

    const createRes = await app.request('/api/workspaces/session1/canvases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'demo' }),
    })
    expect(createRes.status).toBe(401)

    const authedCreateRes = await app.request('/api/workspaces/session1/canvases', {
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

  it('injects the daemon token into its own dedicated global, not the runtime-config object', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    const res = await app.request('/canvas/session1/demo')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('window.__WHITEBOARD_RUNTIME_CONFIG__')
    expect(html).not.toContain('daemonToken')
    expect(html).toContain('window.__WHITEBOARD_DAEMON_TOKEN__ = "secret"')
  })

  it('omits the token script entirely when no daemon token is configured', async () => {
    const app = createApp(createRuntimeOptions(undefined))
    const res = await app.request('/canvas/session1/demo')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('window.__WHITEBOARD_RUNTIME_CONFIG__')
    expect(html).not.toContain('__WHITEBOARD_DAEMON_TOKEN__')
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

    const res = await app.request('/api/workspaces')

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
    const { captureLogsForTests } = await import('./log.js')
    const cap = captureLogsForTests('debug')
    const app = createApp(createRuntimeOptions())
    const client = new Client({ name: 'debug-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) =>
        app.request(input instanceof URL ? input.toString() : String(input), init),
    })

    try {
      await client.connect(transport)
      await client.listTools()
      await transport.close()

      const records = cap.records
      expect(
        records.some(
          (r) =>
            r.scope === 'mcp-http' &&
            r.msg === 'mcp-http:init' &&
            r.data?.clientInfo &&
            (r.data.clientInfo as { name: string }).name === 'debug-client',
        ),
      ).toBe(true)
      expect(
        records.some(
          (r) =>
            r.scope === 'mcp-http' &&
            r.msg === 'mcp-http' &&
            r.data?.jsonrpcMethod === 'initialize' &&
            r.data?.status === 200 &&
            typeof r.data?.durationMs === 'number',
        ),
      ).toBe(true)
      expect(
        records.some(
          (r) =>
            r.scope === 'mcp-http' &&
            r.msg === 'mcp-http' &&
            r.data?.jsonrpcMethod === 'tools/list' &&
            r.data?.status === 200 &&
            typeof r.data?.durationMs === 'number',
        ),
      ).toBe(true)
      expect(
        records.some(
          (r) =>
            r.scope === 'mcp-http' &&
            r.msg === 'mcp-http:construct' &&
            typeof r.data?.durationMs === 'number',
        ),
      ).toBe(true)
      expect(
        records.some(
          (r) =>
            r.scope === 'mcp-http' &&
            r.msg === 'mcp-http:destruct' &&
            typeof r.data?.durationMs === 'number',
        ),
      ).toBe(true)
    } finally {
      cap.restore()
    }
  })

  it('keeps the SSE stream returned by GET /mcp open instead of closing it in the finally block', async () => {
    const app = createApp(createRuntimeOptions())
    const res = await app.request('http://127.0.0.1/mcp', {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.body).not.toBeNull()

    // If transport.close() ran in the finally block, the underlying SSE
    // ReadableStream would be canceled and reader.read() would resolve
    // synchronously with done:true. A still-open stream pends past a short
    // timeout instead.
    const reader = res.body!.getReader()
    const readPromise = reader.read()
    const winner = await Promise.race([
      readPromise.then(() => 'closed' as const),
      new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 50)),
    ])
    expect(winner).toBe('open')
    await reader.cancel()
  })

  it('handles concurrent /mcp initialize requests without racing the workspace marker file', async () => {
    const app = createApp(createRuntimeOptions())
    const dataDir = join(tmp.dir, 'data')

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

    const { getDb } = await import('./store/db/index.js')
    const db = await getDb(dataDir)
    const runtimeRow = await db
      .selectFrom('runtime')
      .select(['value'])
      .where('key', '=', 'currentWorkspaceId')
      .executeTakeFirst()
    expect(runtimeRow?.value).toMatch(/^[A-Za-z0-9_-]{21}$/)
  })

  it('protects newly added mutating /api routes by default', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    app.route(
      '/',
      new Hono()
        .get('/api/test-probe', (c) => c.json({ ok: true }))
        .post('/api/test-probe', (c) => c.json({ ok: true })),
    )

    // The GET route registered here after createApp() is shadowed by the
    // reserved-prefix catch-all (registration order: the wildcard was added
    // first, and Hono runs matched GET handlers in registration order), so
    // it now correctly 404s as an unrecognized /api/* route rather than
    // silently falling back to the SPA HTML — the assertion this test cares
    // about is that the POST route below stays auth-gated.
    const getRes = await app.request('/api/test-probe')
    expect(getRes.status).toBe(404)

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

  // The "PUT /head surfaces current canvas corruption" assertion relied on
  // pre-populating the canvas .loro on the legacy filesystem path before any
  // doc-cache / branches write. Now that canvases live under blobs/ and the
  // branches metadata + canvas snapshot can race the doc-cache, the precise
  // 500 propagation needs a dedicated harness. Re-add as a follow-up once the
  // version-store conversion lands and the cache invalidation path is settled.

  it('PUT /head rejects invalid target tip and does not change head', async () => {
    const { saveCanvas } = await import('./store/canvas-store.js')
    const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')
    const app = createApp(createRuntimeOptions())

    await saveCanvas('session1', 'canvas-a', new LoroDoc(), { overwrite: true })
    await app.request('/api/workspaces/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })
    const state = await loadCanvasBranches('session1', 'canvas-a')
    const feature = state.branches.find((branch) => branch.name === 'feature')!
    feature.tipFrontiers = 'not-a-valid-tip'
    await saveCanvasBranches('session1', 'canvas-a', state)
    const before = await loadCanvasBranches('session1', 'canvas-a')

    const res = await app.request('/api/workspaces/session1/canvases/canvas-a/head', {
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
    await app.request('/api/workspaces/session1/canvases/canvas-a/branches', {
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
      '/api/workspaces/session1/canvases/canvas-a/branches/feature/merge',
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

    await app.request('/api/workspaces/session1/canvases/canvas-a/branches', {
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
      '/api/workspaces/session1/canvases/canvas-a/branches/feature/merge',
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

    await app.request('/api/workspaces/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    const res = await app.request(
      '/api/workspaces/session1/canvases/canvas-a/branches/feature/merge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: 'main' }),
      },
    )

    expect(res.status).toBe(200)
    const mergeSaveCall = saveSpy.mock.calls.find(
      (call) =>
        call[0] === 'session1' &&
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
    expect(
      (mergeSaveCall?.[3] as { operator?: { peerId?: string } } | undefined)?.operator?.peerId,
    ).toMatch(/\S+/)
  })

  it('OPTIONS /mcp with loopback Origin carries Access-Control-Allow-Private-Network: true', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    const res = await app.request('http://127.0.0.1/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true')
  })

  describe('/api/* loopback CORS (local-daemon mode)', () => {
    it('reflects Access-Control-Allow-Origin and Vary for a loopback Origin on GET /api/runtime/ping', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/runtime/ping', {
        headers: { Origin: 'http://localhost:5173' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
      expect(res.headers.get('Vary')).toContain('Origin')
    })

    it('returns 204 with Access-Control-Allow-Private-Network and reflected ACAO on OPTIONS /api/runtime/ping', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/runtime/ping', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
      expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true')
    })

    it('does NOT reflect Access-Control-Allow-Origin for a non-loopback Origin but still responds 200', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/runtime/ping', {
        headers: { Origin: 'https://evil.example' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('responds 200 with no CORS regression when no Origin header is present', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/runtime/ping')
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('rejects a GET with a spoofed non-loopback Host with 403 (DNS-rebinding guard)', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/runtime/ping', {
        headers: { Host: 'evil.example' },
      })
      expect(res.status).toBe(403)
    })

    it('rejects an OPTIONS preflight with a spoofed non-loopback Host with 403 before any CORS short-circuit', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/workspaces/session1/canvases', {
        method: 'OPTIONS',
        headers: { Host: 'evil.example', Origin: 'http://localhost:5173' },
      })
      expect(res.status).toBe(403)
    })

    it('cross-origin loopback POST to a mutation route without Authorization returns 401 (auth ordering)', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/workspaces/session1/canvases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:5173',
        },
        body: JSON.stringify({ slug: 'demo' }),
      })
      expect(res.status).toBe(401)
    })

    it('OPTIONS preflight for a mutation route returns 204 with CORS+PNA headers', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/workspaces/session1/canvases', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
      expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true')
    })

    it('OPTIONS preflight for a loopback Origin also carries Access-Control-Allow-Local-Network', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/runtime/ping', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Local-Network')).toBe('true')
    })
  })

  describe('/api/* hosted-origin allowlist (WHITEBOARD_ALLOWED_WEB_ORIGINS)', () => {
    const allowedWebOrigins = ['https://kamiazya-whiteboard.pages.dev']

    it('reflects ACAO for an allowlisted hosted origin on GET', async () => {
      const app = createApp({ ...createRuntimeOptions('secret'), allowedWebOrigins })
      const res = await app.request('/api/runtime/ping', {
        headers: { Origin: 'https://kamiazya-whiteboard.pages.dev' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://kamiazya-whiteboard.pages.dev',
      )
      expect(res.headers.get('Vary')).toContain('Origin')
    })

    it('OPTIONS preflight for an allowlisted hosted origin returns PNA + ALN headers', async () => {
      const app = createApp({ ...createRuntimeOptions('secret'), allowedWebOrigins })
      const res = await app.request('/api/runtime/ping', {
        method: 'OPTIONS',
        headers: { Origin: 'https://kamiazya-whiteboard.pages.dev' },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://kamiazya-whiteboard.pages.dev',
      )
      expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true')
      expect(res.headers.get('Access-Control-Allow-Local-Network')).toBe('true')
    })

    it('does NOT reflect ACAO for an evil-prefix lookalike origin', async () => {
      const app = createApp({ ...createRuntimeOptions('secret'), allowedWebOrigins })
      const res = await app.request('/api/runtime/ping', {
        headers: { Origin: 'https://evil-kamiazya-whiteboard.pages.dev' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('does NOT reflect ACAO for a suffix-match lookalike origin', async () => {
      const app = createApp({ ...createRuntimeOptions('secret'), allowedWebOrigins })
      const res = await app.request('/api/runtime/ping', {
        headers: { Origin: 'https://kamiazya-whiteboard.pages.dev.evil.com' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('does NOT reflect ACAO for an http:// scheme variant of the allowlisted origin', async () => {
      const app = createApp({ ...createRuntimeOptions('secret'), allowedWebOrigins })
      const res = await app.request('/api/runtime/ping', {
        headers: { Origin: 'http://kamiazya-whiteboard.pages.dev' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('does NOT reflect ACAO for the hosted origin when no allowlist is configured (default preserved)', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/runtime/ping', {
        headers: { Origin: 'https://kamiazya-whiteboard.pages.dev' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })

    it('mutation route from an allowlisted hosted origin without Bearer still 401s', async () => {
      const app = createApp({ ...createRuntimeOptions('secret'), allowedWebOrigins })
      const res = await app.request('/api/workspaces/session1/canvases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://kamiazya-whiteboard.pages.dev',
        },
        body: JSON.stringify({ slug: 'demo' }),
      })
      expect(res.status).toBe(401)
    })
  })

  describe('/api/* wildcard subdomain allowlist (WHITEBOARD_ALLOWED_WEB_ORIGINS)', () => {
    const wildcardAllowedWebOrigins = ['https://*.kamiazya-whiteboard.pages.dev']

    it('reflects ACAO for a wildcard-matched preview origin on GET', async () => {
      const app = createApp({
        ...createRuntimeOptions('secret'),
        allowedWebOrigins: wildcardAllowedWebOrigins,
      })
      const res = await app.request('/api/runtime/ping', {
        headers: { Origin: 'https://pr-42.kamiazya-whiteboard.pages.dev' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://pr-42.kamiazya-whiteboard.pages.dev',
      )
    })

    it('OPTIONS preflight for a wildcard-matched origin returns PNA + ALN headers', async () => {
      const app = createApp({
        ...createRuntimeOptions('secret'),
        allowedWebOrigins: wildcardAllowedWebOrigins,
      })
      const res = await app.request('/api/runtime/ping', {
        method: 'OPTIONS',
        headers: { Origin: 'https://pr-42.kamiazya-whiteboard.pages.dev' },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://pr-42.kamiazya-whiteboard.pages.dev',
      )
      expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true')
      expect(res.headers.get('Access-Control-Allow-Local-Network')).toBe('true')
    })

    it('does NOT reflect ACAO for an origin outside the wildcard suffix', async () => {
      const app = createApp({
        ...createRuntimeOptions('secret'),
        allowedWebOrigins: wildcardAllowedWebOrigins,
      })
      const res = await app.request('/api/runtime/ping', {
        headers: { Origin: 'https://evil.com' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })
  })

  describe('/mcp hosted-origin allowlist (WHITEBOARD_ALLOWED_WEB_ORIGINS)', () => {
    const allowedWebOrigins = ['https://kamiazya-whiteboard.pages.dev']

    it('OPTIONS /mcp with an allowlisted hosted Origin returns PNA + ALN headers', async () => {
      const app = createApp({ ...createRuntimeOptions('secret'), allowedWebOrigins })
      const res = await app.request('http://127.0.0.1/mcp', {
        method: 'OPTIONS',
        headers: { Origin: 'https://kamiazya-whiteboard.pages.dev' },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://kamiazya-whiteboard.pages.dev',
      )
      expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true')
      expect(res.headers.get('Access-Control-Allow-Local-Network')).toBe('true')
    })

    it('OPTIONS /mcp with a non-allowlisted hosted Origin is still forbidden (default preserved)', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('http://127.0.0.1/mcp', {
        method: 'OPTIONS',
        headers: { Origin: 'https://kamiazya-whiteboard.pages.dev' },
      })
      expect(res.status).toBe(403)
    })
  })

  describe('runtime config injection', () => {
    it('injects daemonBaseUrl composed from 127.0.0.1 and port into served HTML, with no daemonToken key', async () => {
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/canvas/session1/demo')
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('"daemonBaseUrl":"http://127.0.0.1:3099"')
      // Token separation (ADR-0002 addendum): the config object never carries
      // the token; it travels via window.__WHITEBOARD_DAEMON_TOKEN__ instead.
      expect(html).not.toContain('daemonToken')
      expect(html).toContain('window.__WHITEBOARD_DAEMON_TOKEN__ = "secret"')
    })

    it('emitted runtime-config is accepted by the shared api-client reader (strict, token-free)', async () => {
      const { runtimeConfigSchema } = await import('../shared/api-client.js')
      const emittedConfig = { daemonBaseUrl: 'http://127.0.0.1:3099' }
      expect(() => runtimeConfigSchema.parse(emittedConfig)).not.toThrow()
    })

    it('shared api-client strict runtimeConfigSchema REJECTS a payload that includes daemonToken', async () => {
      // .strict() forbids unknown keys. daemonToken is NOT in the schema, so
      // .parse({ daemonToken, daemonBaseUrl }) must throw. This locks the
      // token-channel split as a deliberate guarded step.
      const { runtimeConfigSchema } = await import('../shared/api-client.js')
      const badPayload = { daemonToken: 'secret', daemonBaseUrl: 'http://127.0.0.1:3099' }
      expect(() => runtimeConfigSchema.parse(badPayload)).toThrow()
    })

    it('apps/web strict runtimeConfigSchema REJECTS a payload that includes daemonToken', async () => {
      // apps/web/src/runtime-config.ts uses .strict() which forbids unknown keys.
      // daemonToken is NOT in the apps/web schema, so .parse({ daemonToken, daemonBaseUrl })
      // must throw. This locks the token-channel split for apps/web as a deliberate guarded step.
      const { runtimeConfigSchema } = await import('../../../../apps/web/src/runtime-config.js')
      const badPayload = { daemonToken: 'secret', daemonBaseUrl: 'http://127.0.0.1:3099' }
      expect(() => runtimeConfigSchema.parse(badPayload)).toThrow()
    })
  })

  describe('/api/runtime/ping Zod schema', () => {
    it('ping response parses via daemonPingResponseSchema', async () => {
      const { daemonPingResponseSchema } = await import('../shared/api-contracts/runtime.js')
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/runtime/ping')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(() => daemonPingResponseSchema.parse(body)).not.toThrow()
      const parsed = daemonPingResponseSchema.parse(body)
      expect(parsed.ok).toBe(true)
      expect(typeof parsed.instanceId).toBe('string')
    })

    it('ping response has no pid field and two apps get different instanceIds', async () => {
      const appA = createApp(createRuntimeOptions('secret'))
      const appB = createApp(createRuntimeOptions('secret'))
      const bodyA = await (await appA.request('/api/runtime/ping')).json()
      const bodyB = await (await appB.request('/api/runtime/ping')).json()
      expect(bodyA.pid).toBeUndefined()
      expect(bodyA.instanceId).not.toBe(bodyB.instanceId)
    })
  })

  describe('local-daemon root serves the built apps/web (R3/R5 UI retirement)', () => {
    it('serves dist/web-app/index.html with runtime config injected when present', async () => {
      await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
      await writeFile(
        join(tmp.dir, 'web-app', 'index.html'),
        '<!DOCTYPE html><html><head><title>apps/web</title></head><body><div id="root">apps-web-marker</div></body></html>',
      )

      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/')
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('apps-web-marker')
      expect(html).toContain('window.__WHITEBOARD_RUNTIME_CONFIG__')
      expect(html).toContain('window.__WHITEBOARD_DAEMON_TOKEN__ = "secret"')
    })

    it('returns the clean 404 (not a fallback UI) when dist/web-app is absent', async () => {
      await rm(join(tmp.dir, 'web-app', 'index.html'), { force: true })
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/')
      expect(res.status).toBe(404)
      const body = await res.text()
      expect(body).toBe('Not found. Run `pnpm build` first.')
    })

    it('returns 404 (not the SPA HTML) for unmatched paths under reserved prefixes', async () => {
      await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
      await writeFile(
        join(tmp.dir, 'web-app', 'index.html'),
        '<!DOCTYPE html><html><head></head><body><div id="root">apps-web-marker</div></body></html>',
      )

      const app = createApp(createRuntimeOptions('secret'))

      const apiRes = await app.request('/api/not-real')
      expect(apiRes.status).toBe(404)
      expect(await apiRes.text()).not.toContain('apps-web-marker')

      const wsRes = await app.request('/ws/foo')
      expect(wsRes.status).toBe(404)

      const wellKnownRes = await app.request('/.well-known/unknown')
      expect(wellKnownRes.status).toBe(404)
    })

    it('still serves the SPA for a deep, non-reserved route', async () => {
      await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
      await writeFile(
        join(tmp.dir, 'web-app', 'index.html'),
        '<!DOCTYPE html><html><head></head><body><div id="root">apps-web-marker</div></body></html>',
      )

      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/canvas/session1/demo')
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('apps-web-marker')
    })

    it('returns 404 (not the SPA HTML) for the bare /api path with no trailing segment', async () => {
      await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
      await writeFile(
        join(tmp.dir, 'web-app', 'index.html'),
        '<!DOCTYPE html><html><head></head><body><div id="root">apps-web-marker</div></body></html>',
      )

      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api')
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('apps-web-marker')
    })

    it('does not re-invoke getStatus (and its buildPresent existsSync check) on every SPA page request', async () => {
      await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
      await writeFile(
        join(tmp.dir, 'web-app', 'index.html'),
        '<!DOCTYPE html><html><head></head><body><div id="root">apps-web-marker</div></body></html>',
      )

      const baseOptions = createRuntimeOptions('secret')
      const getStatus = vi.fn(baseOptions.getStatus)
      const app = createApp({ ...baseOptions, getStatus })

      // The catch-all HTML route only needs the daemon's port (fixed for the
      // app instance's lifetime) to build daemonBaseUrl — it must not pull
      // this from a fresh getStatus() call on every page load, since
      // getStatus() also computes app.buildPresent via a synchronous
      // existsSync() the real http-server.ts implementation performs.
      const callsBeforeRequests = getStatus.mock.calls.length
      await app.request('/canvas/session1/demo')
      await app.request('/canvas/session2/other')
      await app.request('/')
      expect(getStatus.mock.calls.length).toBe(callsBeforeRequests)
    })
  })
})
