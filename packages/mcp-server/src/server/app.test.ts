import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { workspaceCanonicalIdSchema } from '@kamiazya/whiteboard-model'
import {
  Client,
  LATEST_PROTOCOL_VERSION,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTempDataDir } from './routes/_test-helpers.js'
import type { McpProtectedResourceMetadataConfig } from './security/mcp-auth.js'

const tmp = withTempDataDir('whiteboard-app-test-')

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
const { clearCache } = await import('./store/doc-cache.js')
const { clearWorkspaceIdCache } = await import('./current-workspace.js')
const { PACKAGE_VERSION } = await import('../shared/package-version.js')

function createRuntimeOptions(
  token?: string,
  options?: { protectedResourceMetadata?: McpProtectedResourceMetadataConfig },
) {
  return {
    authMode: 'local-daemon' as const,
    token,
    mcpProtectedResourceMetadata: options?.protectedResourceMetadata,
    touch: vi.fn(),
    getStatus: () => ({
      ok: true,
      pid: 10,
      socketPath: '/run/user/1000/whiteboard/d.sock',
      version: PACKAGE_VERSION,
      startedAt: '2026-04-23T00:00:00.000Z',
      uptimeMs: 100,
      idleForMs: 10,
      auth: { mode: 'local-token', hasToken: Boolean(token) },
      storage: { dataDir: '/tmp', dataDirWritable: true },
      mcp: { httpEnabled: true },
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

  it('read routes require bearer auth just like mutation routes', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    // ADR-0002's original carve-out left canvas/asset GET tokenless, relying
    // on loopback-only reachability. ADR-0005 retires that assumption for a
    // hosted-origin caller, and the client already authenticates every read
    // (apiFetch attaches the bearer to every same-origin /api/* request), so
    // the server now requires it here too instead of silently accepting an
    // unauthenticated read.
    const unauthedListRes = await app.request('/api/workspaces')
    expect(unauthedListRes.status).toBe(401)

    const listRes = await app.request('/api/workspaces', {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(listRes.status).toBe(200)

    const debugRes = await app.request('/api/debug')
    expect(debugRes.status).toBe(401)

    const createRes = await app.request('/api/workspaces/session1/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'demo' }),
    })
    expect(createRes.status).toBe(401)

    const authedCreateRes = await app.request('/api/workspaces/session1/documents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
      },
      body: JSON.stringify({ path: 'demo' }),
    })
    expect(authedCreateRes.status).toBe(200)
    await expect(authedCreateRes.json()).resolves.toEqual({ path: 'demo' })

    const authedDebugRes = await app.request('/api/debug', {
      headers: {
        Authorization: 'Bearer secret',
      },
    })
    expect(authedDebugRes.status).toBe(200)
  })

  it('adds the same baseline security headers to API responses', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('/api/workspaces', {
      headers: { Authorization: 'Bearer secret' },
    })

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
    const workspaceEditTool = tools.tools.find((tool) => tool.name === 'wb_workspace_edit')
    const createResult = await client.callTool({
      name: 'wb_workspace_edit',
      arguments: {
        workspaceId: 'default',
        createWorkspace: true,
        ops: [{ op: 'document.create', path: 'via-mcp', kind: 'spatial' }],
      },
    })

    expect(workspaceEditTool).toBeDefined()
    expect(workspaceEditTool?.outputSchema).toBeDefined()
    expect(createResult.structuredContent).toMatchObject({
      applied: 1,
      results: [{ documentId: expect.any(String), path: 'via-mcp' }],
    })
    expect(createResult.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify(createResult.structuredContent),
      },
    ])
    await transport.close()
  })

  it('serves the 2026-07-28 revision on /mcp for a modern-pinned client', async () => {
    // versionNegotiation pin means no legacy fallback: connect() succeeds only
    // when the endpoint actually serves the modern (2026-07-28) era.
    const app = createApp(createRuntimeOptions('secret'))
    const client = new Client(
      { name: 'app-modern-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    )
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
    expect(client.getProtocolEra()).toBe('modern')
    const tools = await client.listTools()
    expect(tools.tools.some((tool) => tool.name === 'wb_workspace_edit')).toBe(true)
    const createResult = await client.callTool({
      name: 'wb_workspace_edit',
      arguments: {
        workspaceId: 'default',
        createWorkspace: true,
        ops: [{ op: 'document.create', path: 'via-modern-mcp', kind: 'spatial' }],
      },
    })
    expect(createResult.structuredContent).toMatchObject({
      applied: 1,
      results: [{ documentId: expect.any(String), path: 'via-modern-mcp' }],
    })
    await transport.close()
  })

  /**
   * Orientation rides `instructions` on the initialize result — the
   * protocol's own channel, which a client injects into the model's system
   * prompt rather than having to know to fetch a resource.
   *
   * This case used to pin a help RESOURCE, and required its body to name a
   * specific tool. That is worth knowing before anyone asserts on the text
   * again: an end-to-end test through a real MCP client will hold whatever
   * the text says, including a tool that no longer exists. Assert the channel
   * and the shape, not the wording.
   */
  it('hands the client its instructions at initialize, and still offers the draw prompt', async () => {
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

    // The initialize result's own field, read back through the client.
    const instructions = client.getInstructions()
    expect(instructions).toBeTruthy()
    expect(instructions).toContain('DOCUMENTS')

    const resources = await client.listResources()
    expect(
      resources.resources.find((resource) => resource.uri === 'whiteboard://help/getting-started'),
    ).toBeUndefined()

    const prompts = await client.listPrompts()
    expect(
      prompts.prompts.find((prompt) => prompt.name === 'whiteboard.draw_diagram'),
    ).toMatchObject({ name: 'whiteboard.draw_diagram' })

    const prompt = await client.getPrompt({
      name: 'whiteboard.draw_diagram',
      arguments: { goal: 'Summarize the payment flow' },
    })
    expect(prompt.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('Summarize the payment flow'),
        }),
      }),
    ])
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
    // Concurrency is this test's subject — 32 initializes must settle on ONE
    // id — and the shape is incidental to that. It asserts the canonical
    // schema rather than a literal pattern so it does not quietly become a
    // second place the id format is pinned; `current-workspace.test.ts` owns
    // that.
    expect(workspaceCanonicalIdSchema.safeParse(runtimeRow?.value).success).toBe(true)
  })

  it('protects newly added /api routes by default, GET included', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    app.route(
      '/',
      new Hono()
        .get('/api/test-probe', (c) => c.json({ ok: true }))
        .post('/api/test-probe', (c) => c.json({ ok: true })),
    )

    // The bearer-auth middleware in app.ts runs ahead of routing for all of
    // /api/*, so an unauthenticated GET here 401s before Hono ever resolves
    // which handler (this test's late-registered probe, or the
    // reserved-prefix catch-all) would have matched.
    const getRes = await app.request('/api/test-probe')
    expect(getRes.status).toBe(401)

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
  // doc-cache / branches write. Now that documents live under blobs/ and the
  // branches metadata + canvas snapshot can race the doc-cache, the precise
  // 500 propagation needs a dedicated harness. Re-add as a follow-up once the
  // version-store conversion lands and the cache invalidation path is settled.

  describe('/api/runtime/ping Zod schema', () => {
    it('ping response parses via daemonPingResponseSchema', async () => {
      const { daemonPingResponseSchema } = await import(
        '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
      )
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

  // ADR-0050 decision 3: the hosted app reaches the daemon through the
  // extension, so the daemon serves no page at all.
  it('serves no page: the root, /pair and a deep route all answer 404', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    for (const path of ['/', '/pair', '/documents/board']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('Content-Type') ?? '', path).not.toContain('text/html')
    }
  })

  it('answers no CORS preflight, so no web origin can call it directly', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    const res = await app.request('/api/runtime/ping', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(res.headers.get('Access-Control-Allow-Private-Network')).toBeNull()
  })
})
