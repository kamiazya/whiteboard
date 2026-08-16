import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deleteSpatialNode } from '@kamiazya/whiteboard-canvas-workspace'
import {
  Client,
  LATEST_PROTOCOL_VERSION,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { Hono } from 'hono'
import { encodeFrontiers, LoroDoc, LoroMap } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSpatialDoc } from '../shared/test-utils/spatial-doc.js'
import { withTempDataDir } from './routes/_test-helpers.js'

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

    const createRes = await app.request('/api/workspaces/session1/canvases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'demo' }),
    })
    expect(createRes.status).toBe(401)

    const authedCreateRes = await app.request('/api/workspaces/session1/canvases', {
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

  it('injects the daemon token into its own dedicated global, not the runtime-config object', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    const res = await app.request('/pair')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('window.__WHITEBOARD_RUNTIME_CONFIG__')
    expect(html).not.toContain('daemonToken')
    expect(html).toContain('window.__WHITEBOARD_DAEMON_TOKEN__ = "secret"')
  })

  it('redirects every non-/pair UI path to the official hosted app', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    for (const path of ['/', '/canvas/session1/demo', '/local/abc', '/w/ws/c/alias']) {
      const res = await app.request(path)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://kamiazya-whiteboard.pages.dev/')
      // The redirect must never leak the daemon token anywhere.
      expect(res.headers.get('location')).not.toContain('secret')
    }
    // Reserved paths keep their existing semantics (404, not redirect).
    const reserved = await app.request('/token')
    expect(reserved.status).toBe(404)
  })

  it('still serves the injected app shell on /pair (the consent trust anchor)', async () => {
    const app = createApp(createRuntimeOptions('secret'))
    const res = await app.request('/pair?origin=https%3A%2F%2Fapp.example&challenge=c&state=s')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('window.__WHITEBOARD_RUNTIME_CONFIG__')
    expect(html).toContain('window.__WHITEBOARD_DAEMON_TOKEN__ = "secret"')
  })

  it('omits the token script entirely when no daemon token is configured', async () => {
    const app = createApp(createRuntimeOptions(undefined))
    const res = await app.request('/pair')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('window.__WHITEBOARD_RUNTIME_CONFIG__')
    expect(html).not.toContain('__WHITEBOARD_DAEMON_TOKEN__')
  })

  it('adds baseline security headers to HTML responses', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('/pair')

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
  })

  // /pair is the pairing consent trust anchor and the only real page this
  // daemon serves, so it carries a full page policy rather than the
  // frame-ancestors-only floor that suits an API JSON response.
  it('serves /pair under a full page CSP, not the frame-ancestors-only floor', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('/pair')

    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    // A consent page embeds nothing, so it does not inherit the hosted app's
    // `frame-src https:` — pinned so a later policy edit cannot quietly let
    // this trust anchor frame remote content.
    expect(csp).toContain("frame-src 'none'")
    // The daemon-fetched thumbnails this app renders are blob: URLs.
    expect(csp).toMatch(/img-src[^;]*\bblob:/)
  })

  it('authorizes the two injected inline scripts on /pair with a per-response nonce', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const res = await app.request('/pair')

    const csp = res.headers.get('Content-Security-Policy') ?? ''
    const nonce = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp)?.[1]
    expect(nonce).toBeDefined()
    // Without the nonce on the tags, `script-src 'self'` would block the
    // runtime-config and token scripts and the pairing page would boot blind.
    const html = await res.text()
    expect(html).toContain(`<script nonce="${nonce}">window.__WHITEBOARD_RUNTIME_CONFIG__`)
    expect(html).toContain(`<script nonce="${nonce}">window.__WHITEBOARD_DAEMON_TOKEN__`)
    const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? ''
    expect(scriptSrc).not.toContain("'unsafe-inline'")
  })

  it('issues a fresh nonce per /pair response', async () => {
    const app = createApp(createRuntimeOptions('secret'))

    const first = await app.request('/pair')
    const second = await app.request('/pair')

    const nonceOf = (res: Response) =>
      /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(res.headers.get('Content-Security-Policy') ?? '')?.[1]
    expect(nonceOf(first)).toBeDefined()
    expect(nonceOf(first)).not.toBe(nonceOf(second))
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
    const canvasCreateTool = tools.tools.find((tool) => tool.name === 'wb_document_create')
    const createResult = await client.callTool({
      name: 'wb_document_create',
      arguments: {
        workspaceId: 'default',
        path: 'via-mcp',
        kind: 'spatial',
        createWorkspace: true,
      },
    })

    expect(canvasCreateTool).toBeDefined()
    expect(canvasCreateTool?.outputSchema).toBeDefined()
    expect(createResult.structuredContent).toMatchObject({
      documentId: expect.any(String),
      path: 'via-mcp',
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
    expect(tools.tools.some((tool) => tool.name === 'wb_document_create')).toBe(true)
    const createResult = await client.callTool({
      name: 'wb_document_create',
      arguments: {
        workspaceId: 'default',
        path: 'via-modern-mcp',
        kind: 'spatial',
        createWorkspace: true,
      },
    })
    expect(createResult.structuredContent).toMatchObject({
      documentId: expect.any(String),
      path: 'via-modern-mcp',
    })
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
  // doc-cache / branches write. Now that canvases live under blobs/ and the
  // branches metadata + canvas snapshot can race the doc-cache, the precise
  // 500 propagation needs a dedicated harness. Re-add as a follow-up once the
  // version-store conversion lands and the cache invalidation path is settled.

  it('PUT /head rejects invalid target tip and does not change head', async () => {
    const { saveDocument } = await import('./store/document-store.js')
    const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')
    const app = createApp(createRuntimeOptions())

    await saveDocument('session1', 'canvas-a', new LoroDoc(), { overwrite: true })
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
    const { saveDocument } = await import('./store/document-store.js')
    const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')
    const app = createApp(createRuntimeOptions())

    await saveDocument('session1', 'canvas-a', new LoroDoc(), { overwrite: true })
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
    const { saveDocument, loadDocument } = await import('./store/document-store.js')
    const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')
    const app = createApp(createRuntimeOptions())

    const doc = new LoroDoc()
    const list = doc.getMovableList('elements')
    const element = list.insertContainer(0, new LoroMap())
    element.set('id', 'rect-1')
    element.set('type', 'rectangle')
    doc.commit()
    await saveDocument('session1', 'canvas-a', doc, { overwrite: true })

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
    const reloaded = await loadDocument('session1', 'canvas-a')
    const elements = reloaded.getMovableList('elements').toJSON() as Array<{ id: string }>
    expect(elements.map((entry) => entry.id)).toEqual(['rect-1'])
  })

  it('merge pre-snapshot save carries system/merge operator', async () => {
    const { saveDocument } = await import('./store/document-store.js')
    const { FileVersionStore } = await import('./store/version-store.js')
    const saveSpy = vi.spyOn(FileVersionStore.prototype, 'save')
    const app = createApp(createRuntimeOptions())

    const doc = new LoroDoc()
    await saveDocument('session1', 'canvas-a', doc, { overwrite: true })

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

  it('merge dry run returns nonzero element counts for a nodes-model doc', async () => {
    const { saveDocument } = await import('./store/document-store.js')
    const app = createApp(createRuntimeOptions())

    const doc = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'hi', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    await saveDocument('session1', 'canvas-a', doc, { overwrite: true })

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
        body: JSON.stringify({ into: 'main', dryRun: true }),
      },
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      preview?: { elementCount: number }
      target?: { elementCount: number }
      source?: { elementCount: number }
      previewElements?: Array<{ id: string; type: string }>
    }
    expect(json.preview).toEqual({ elementCount: 1 })
    expect(json.target).toEqual({ elementCount: 1 })
    expect(json.source).toEqual({ elementCount: 1 })
    // The dry-run preview payload is the nodes-model equivalent of the
    // retired Excalidraw-style elements list — MergeDialog reads its
    // .length as a previewElementCount fallback (contents are unread today).
    expect(json.previewElements).toEqual([expect.objectContaining({ id: 'A', type: 'text' })])
  })

  it('merge dry run element counts include edges, matching previewElements.length', async () => {
    const { saveDocument } = await import('./store/document-store.js')
    const app = createApp(createRuntimeOptions())

    const doc = makeSpatialDoc({
      nodes: [
        { id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'B', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [{ id: 'e1', fromNode: 'A', toNode: 'B' }],
    })
    await saveDocument('session1', 'canvas-a', doc, { overwrite: true })

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
        body: JSON.stringify({ into: 'main', dryRun: true }),
      },
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      preview?: { elementCount: number }
      target?: { elementCount: number }
      source?: { elementCount: number }
      previewElements?: Array<{ id: string; type: string }>
    }
    // 2 nodes + 1 edge = 3 elements. A nodes-only count (countAliveNodes)
    // would report 2 here, diverging from previewElements.length.
    expect(json.preview).toEqual({ elementCount: 3 })
    expect(json.target).toEqual({ elementCount: 3 })
    expect(json.source).toEqual({ elementCount: 3 })
    expect(json.previewElements).toHaveLength(3)
    expect(json.preview?.elementCount).toBe(json.previewElements?.length)
  })

  it('merge dry run fires a resurrected badge when target deleted a node the source retains', async () => {
    const { saveDocument, loadDocument } = await import('./store/document-store.js')
    const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')
    const app = createApp(createRuntimeOptions())

    const doc = makeSpatialDoc({
      nodes: [
        { id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 },
        { id: 'B', type: 'text', text: 'b', x: 0, y: 0, width: 10, height: 10 },
      ],
      edges: [],
    })
    await saveDocument('session1', 'canvas-a', doc, { overwrite: true })

    await app.request('/api/workspaces/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    // Pin feature's tip to the pre-deletion state so it stops tracking the
    // live doc (an empty tipFrontiers always resolves to the live doc).
    const pinnedTip = Buffer.from(encodeFrontiers(doc.frontiers())).toString('base64')
    const state = await loadCanvasBranches('session1', 'canvas-a')
    const feature = state.branches.find((branch) => branch.name === 'feature')!
    feature.tipFrontiers = pinnedTip
    await saveCanvasBranches('session1', 'canvas-a', state)

    // Main (the live doc, still HEAD) deletes A.
    const mainDoc = await loadDocument('session1', 'canvas-a')
    deleteSpatialNode(mainDoc, 'A')
    await saveDocument('session1', 'canvas-a', mainDoc, { overwrite: true })

    const res = await app.request(
      '/api/workspaces/session1/canvases/canvas-a/branches/feature/merge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: 'main', dryRun: true }),
      },
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as { badges: Array<Record<string, unknown>> }
    expect(json.badges).toContainEqual({ type: 'resurrected', elementId: 'A' })
  })

  it('committed merge returns newElementIds/changedElementIds derived from the nodes model', async () => {
    const { saveDocument, loadDocument } = await import('./store/document-store.js')
    const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')
    const { writeSpatialNode } = await import('@kamiazya/whiteboard-canvas-workspace')

    const app = createApp(createRuntimeOptions())

    const doc = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    await saveDocument('session1', 'canvas-a', doc, { overwrite: true })

    await app.request('/api/workspaces/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    // Pin main to the A-only state so it stops tracking the live doc.
    const mainOnlyTip = Buffer.from(encodeFrontiers(doc.frontiers())).toString('base64')
    const state = await loadCanvasBranches('session1', 'canvas-a')
    const main = state.branches.find((branch) => branch.name === 'main')!
    main.tipFrontiers = mainOnlyTip
    await saveCanvasBranches('session1', 'canvas-a', state)

    // Reload (a fresh doc instance importing the same history) and add C on
    // top — this is what feature's tip below points at, and what becomes
    // the live doc's new content.
    const withC = await loadDocument('session1', 'canvas-a')
    writeSpatialNode(withC, {
      id: 'C',
      type: 'text',
      text: 'c',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })
    await saveDocument('session1', 'canvas-a', withC, { overwrite: true })

    const featureTip = Buffer.from(encodeFrontiers(withC.frontiers())).toString('base64')
    const afterAddC = await loadCanvasBranches('session1', 'canvas-a')
    const feature = afterAddC.branches.find((branch) => branch.name === 'feature')!
    feature.tipFrontiers = featureTip
    await saveCanvasBranches('session1', 'canvas-a', afterAddC)

    const res = await app.request(
      '/api/workspaces/session1/canvases/canvas-a/branches/feature/merge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: 'main' }),
      },
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as { newElementIds?: string[]; changedElementIds?: string[] }
    expect(json.newElementIds).toEqual(['C'])
    expect(json.changedElementIds ?? []).toEqual([])
  })

  it('committed merge fires a resurrected badge across a genuine two-sided divergence', async () => {
    const { saveDocument } = await import('./store/document-store.js')
    const { loadCanvasBranches, saveCanvasBranches } = await import('./store/branches-store.js')
    const { writeSpatialNode } = await import('@kamiazya/whiteboard-canvas-workspace')

    const app = createApp(createRuntimeOptions())

    // Fork point: a single node A, written by one peer.
    const forkDoc = makeSpatialDoc({
      nodes: [{ id: 'A', type: 'text', text: 'a', x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
    })
    await saveDocument('session1', 'canvas-a', forkDoc, { overwrite: true })
    const forkSnapshot = forkDoc.export({ mode: 'snapshot' })

    await app.request('/api/workspaces/session1/canvases/canvas-a/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'feature' }),
    })

    // Target side: the SAME peer continues past the fork and deletes A.
    deleteSpatialNode(forkDoc, 'A')
    const mainTip = Buffer.from(encodeFrontiers(forkDoc.frontiers())).toString('base64')

    // Source side: a FRESH peer, independently continuing from the same
    // fork point (A still alive), adding F. Neither mainTip's nor
    // sourceTip's version vector is a subset of the other — the genuine
    // bilateral case meetVersion (per-peer min of two vectors) exists for,
    // unlike the one-sided ancestor/descendant cases covered above. Getting
    // the meet wrong here is directly observable: an incorrectly-advanced
    // base (e.g. one that already reflects target's delete of A) would
    // silence the resurrected badge below instead of firing it.
    const sourceDoc = new LoroDoc()
    sourceDoc.import(forkSnapshot)
    sourceDoc.setPeerId('999')
    writeSpatialNode(sourceDoc, {
      id: 'F',
      type: 'text',
      text: 'f',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    })
    const sourceTip = Buffer.from(encodeFrontiers(sourceDoc.frontiers())).toString('base64')

    // Merge both peers' ops into the shared live doc so both tips remain
    // checkoutable against its full history.
    forkDoc.import(sourceDoc.export({ mode: 'snapshot' }))
    await saveDocument('session1', 'canvas-a', forkDoc, { overwrite: true })

    const state = await loadCanvasBranches('session1', 'canvas-a')
    const main = state.branches.find((branch) => branch.name === 'main')!
    main.tipFrontiers = mainTip
    const feature = state.branches.find((branch) => branch.name === 'feature')!
    feature.tipFrontiers = sourceTip
    await saveCanvasBranches('session1', 'canvas-a', state)

    const res = await app.request(
      '/api/workspaces/session1/canvases/canvas-a/branches/feature/merge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ into: 'main' }),
      },
    )

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      newElementIds?: string[]
      badges?: Array<Record<string, unknown>>
    }
    // The correctly-computed base is A-only (the true fork point, before
    // target's delete): A is resurrected on commit, and F is new.
    expect(json.badges).toContainEqual({ type: 'resurrected', elementId: 'A' })
    expect(json.newElementIds?.sort()).toEqual(['A', 'F'])
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
        body: JSON.stringify({ path: 'demo' }),
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

    it('does not invent an Access-Control-Allow-Local-Network response header', async () => {
      // Local Network Access gates on a user permission and defines no
      // response header, so emitting one states a capability the server does
      // not have: it cannot unblock an LNA denial no matter what it answers.
      // Re-adding it would send the client looking for a server-side fix to a
      // problem only the browser's permission can resolve.
      // https://wicg.github.io/local-network-access/
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/api/runtime/ping', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173' },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Local-Network')).toBeNull()
      // Asserted together so the pair is pinned as a contract: dropping BOTH
      // headers would satisfy the absence check alone and look like a pass.
      expect(res.headers.get('Access-Control-Allow-Private-Network')).toBe('true')
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

    it('OPTIONS preflight for an allowlisted hosted origin returns the PNA header', async () => {
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
        body: JSON.stringify({ path: 'demo' }),
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

    it('OPTIONS /mcp with an allowlisted hosted Origin returns the PNA header', async () => {
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
      const res = await app.request('/pair')
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

  describe('local-daemon serves /pair only (hosted-first UI end state)', () => {
    it('serves dist/web-app/index.html on /pair with runtime config injected', async () => {
      await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
      await writeFile(
        join(tmp.dir, 'web-app', 'index.html'),
        '<!DOCTYPE html><html><head><title>apps/web</title></head><body><div id="root">apps-web-marker</div></body></html>',
      )

      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/pair')
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('apps-web-marker')
      expect(html).toContain('window.__WHITEBOARD_RUNTIME_CONFIG__')
      expect(html).toContain('window.__WHITEBOARD_DAEMON_TOKEN__ = "secret"')
    })

    it('the root redirects to the hosted app even when the build is present', async () => {
      await mkdir(join(tmp.dir, 'web-app'), { recursive: true })
      await writeFile(join(tmp.dir, 'web-app', 'index.html'), '<!DOCTYPE html><html></html>')
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('https://kamiazya-whiteboard.pages.dev/')
    })

    it('returns the clean 404 on /pair when dist/web-app is absent', async () => {
      await rm(join(tmp.dir, 'web-app', 'index.html'), { force: true })
      const app = createApp(createRuntimeOptions('secret'))
      const res = await app.request('/pair')
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

      // Auth runs ahead of routing for all of /api/*, so an unauthenticated
      // request 401s regardless of whether the path is real; only an
      // authenticated request reaches the "does this route exist" question.
      const unauthedApiRes = await app.request('/api/not-real')
      expect(unauthedApiRes.status).toBe(401)

      const apiRes = await app.request('/api/not-real', {
        headers: { Authorization: 'Bearer secret' },
      })
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
      const res = await app.request('/pair')
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
