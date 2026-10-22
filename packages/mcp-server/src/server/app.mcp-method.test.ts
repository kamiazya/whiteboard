/**
 * The composed `/mcp` answers only the methods it serves: POST and DELETE,
 * and GET where the local daemon offers the listen stream. Hono runs HEAD
 * through the GET handler while `c.req.method` still reads HEAD, so a guard
 * that names GET alone lets HEAD through to the transport — which does
 * refuse it, but only after the caller was authorized and a whole MCP server
 * was built for it. Every other method is refused here before either.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import {
  bearerNamesItsSubject,
  isolatedServerModePeople,
  PUBLIC_URL,
} from './_test-server-mode-harness.js'
import { testDataLayout } from './routes/_test-helpers.js'

const built = vi.hoisted(() => ({ count: 0 }))
vi.mock('./mcp/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcp/server.js')>()
  return {
    ...actual,
    createMcpServer: (...args: Parameters<typeof actual.createMcpServer>) => {
      built.count += 1
      return actual.createMcpServer(...args)
    },
  }
})

const { createApp } = await import('./app.js')

const dataDir = mkdtempSync(join(tmpdir(), 'wb-mcp-method-'))
setDataDirForTests(dataDir)
afterAll(() => {
  resetDataDirForTests()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

let serverModeApp: ReturnType<typeof createApp>
let disposePeople: () => Promise<void>
beforeAll(async () => {
  const { people, dispose } = await isolatedServerModePeople(dataDir)
  disposePeople = dispose
  serverModeApp = createApp({
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(),
    people,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  })
})
afterAll(async () => {
  await disposePeople()
})
beforeEach(() => {
  built.count = 0
})

const TOKEN = 'mcp-method-test-token'

function localDaemonApp() {
  return createApp({
    authMode: 'local-daemon' as const,
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({ port: 3099 }) as never,
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(),
  })
}

const ERA = {
  legacy: {},
  modern: { 'mcp-protocol-version': '2026-07-28' },
} as const

describe('server mode /mcp methods', () => {
  // No credential: a refusal that reached auth would answer 401.
  it.each([
    ['HEAD', 'legacy'],
    ['HEAD', 'modern'],
    ['GET', 'legacy'],
    ['PUT', 'legacy'],
    ['PATCH', 'modern'],
  ] as const)('answers a %s (%s) with 405 before auth and builds no server', async (method, era) => {
    const res = await serverModeApp.request(`${PUBLIC_URL}/mcp`, {
      method,
      headers: { accept: 'application/json, text/event-stream', ...ERA[era] },
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST, DELETE')
    expect(built.count).toBe(0)
  })

  it('still answers a CORS preflight from an allowed origin', async () => {
    const res = await serverModeApp.request(`${PUBLIC_URL}/mcp`, {
      method: 'OPTIONS',
      headers: { origin: PUBLIC_URL, 'access-control-request-method': 'POST' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_URL)
  })

  it('still sends a POST on to auth', async () => {
    const res = await serverModeApp.request(`${PUBLIC_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('local daemon /mcp methods', () => {
  it.each([
    ['HEAD', 'legacy'],
    ['HEAD', 'modern'],
    ['PUT', 'legacy'],
    ['PATCH', 'modern'],
    ['OPTIONS', 'legacy'],
  ] as const)('answers a %s (%s) with 405 before auth and builds no server', async (method, era) => {
    const res = await localDaemonApp().request('/mcp', {
      method,
      headers: { accept: 'application/json, text/event-stream', ...ERA[era] },
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET, POST, DELETE')
    expect(built.count).toBe(0)
  })

  it('still opens the listen stream for an authorized GET', async () => {
    const res = await localDaemonApp().request('/mcp', {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await res.body?.cancel()
    expect(built.count).toBe(1)
  })

  it.each(['GET', 'POST', 'DELETE'])('still sends %s on to auth', async (method) => {
    const res = await localDaemonApp().request('/mcp', { method })
    expect(res.status).toBe(401)
  })
})
