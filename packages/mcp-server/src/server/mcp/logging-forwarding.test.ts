// Which client a log record reaches, through the real roots: `createApp`'s
// `/mcp` (both eras) and `serveStdio` over the `createMcpServer` factory. A
// record is forwarded only to the request that emitted it — never to another
// caller, and never from code that belongs to no request.
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { describe, expect, it, vi } from 'vitest'
import { storeMemoryModule } from '../../shared/test-utils/store-memory.module.js'
import { testDataLayout, withTempDataDir } from '../routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-mcp-log-forwarding-')
vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return join(tmp.dir, 'data')
  },
  getDataDir: () => join(tmp.dir, 'data'),
  get DIST_WEB_APP_DIR() {
    return join(tmp.dir, 'web-app')
  },
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { createApp } = await import('../app.js')
const { createContainer, resolveServerDeps } = await import('../../di/container.js')
const { createMcpServer } = await import('./server.js')
const { getLogger } = await import('../log.js')

const MODERN = '2026-07-28'
const LOG_LEVEL_META = { 'io.modelcontextprotocol/logLevel': 'debug' }
const WORKSPACE = 'log-forwarding'

/**
 * Deps whose `listDocuments` — reached by `wb_document_list` — holds each call
 * until `release()`, then logs a warning naming that call. `entered(n)`
 * resolves once n calls are held, so the test can log from OUTSIDE every
 * request while they are all in flight.
 */
async function gatedDeps() {
  const base = resolveServerDeps(createContainer(storeMemoryModule))
  await base.documentIndex.createWorkspace({ workspaceId: WORKSPACE })
  let held = 0
  const waiters: Array<{ n: number; resolve: () => void }> = []
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const index = base.documentIndex
  const documentIndex = new Proxy(index, {
    get(target, key, receiver) {
      if (key === 'listDocuments') {
        return async (input: Parameters<typeof index.listDocuments>[0]) => {
          held += 1
          const marker = `in-call-${held}`
          for (const w of waiters) if (held >= w.n) w.resolve()
          await released
          getLogger('log-forwarding').warning({ marker }, marker)
          return target.listDocuments(input)
        }
      }
      const value = Reflect.get(target, key, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const deps: ServerDeps = { ...base, documentIndex }
  const entered = (n: number) =>
    new Promise<void>((resolve) => {
      if (held >= n) resolve()
      else waiters.push({ n, resolve })
    })
  return { deps, entered, release }
}

function collect(client: Client): string[] {
  const got: string[] = []
  client.setNotificationHandler('notifications/message', (n) => {
    const data = n.params.data as { msg?: unknown }
    got.push(String(data.msg))
  })
  return got
}

function listCall(meta?: Record<string, unknown>) {
  return {
    name: 'wb_document_list',
    arguments: { workspaceId: WORKSPACE },
    ...(meta === undefined ? {} : { _meta: meta }),
  }
}

async function httpClient(deps: ServerDeps, pin?: string) {
  const app = createApp({
    authMode: 'local-daemon',
    token: 'secret',
    serverDeps: deps,
    dataLayout: testDataLayout(),
    touch: vi.fn(),
    getStatus: () => ({ ok: true }),
  } as never)
  const client = new Client(
    { name: 'log-forwarding', version: '1' },
    pin === undefined ? undefined : ({ versionNegotiation: { mode: { pin } } } as never),
  )
  const got = collect(client)
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1/mcp'), {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set('Authorization', 'Bearer secret')
      headers.set('Origin', 'http://127.0.0.1:6274')
      return await app.request(input instanceof URL ? input.toString() : String(input), {
        ...init,
        headers,
      })
    },
  })
  await client.connect(transport)
  return { client, got, close: () => transport.close() }
}

async function stdioClient(deps: ServerDeps, pin?: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const handle = serveStdio(() => createMcpServer(deps), { transport: serverSide })
  const client = new Client(
    { name: 'log-forwarding', version: '1' },
    pin === undefined ? undefined : ({ versionNegotiation: { mode: { pin } } } as never),
  )
  const got = collect(client)
  await client.connect(clientSide)
  return {
    client,
    got,
    close: async () => {
      await client.close()
      await handle.close()
    },
  }
}

const markers = (got: readonly string[]) => got.filter((m) => m.startsWith('in-call-'))

describe('MCP log forwarding over HTTP /mcp, modern era', () => {
  it('delivers a tool call’s record to its own caller and to no concurrent one', async () => {
    const { deps, entered, release } = await gatedDeps()
    const a = await httpClient(deps, MODERN)
    const b = await httpClient(deps, MODERN)
    try {
      const calls = [
        a.client.callTool(listCall(LOG_LEVEL_META)),
        b.client.callTool(listCall(LOG_LEVEL_META)),
      ]
      await entered(2)
      getLogger('log-forwarding').warning('outside every request')
      release()
      await Promise.all(calls)
      expect(markers(a.got)).toHaveLength(1)
      expect(markers(b.got)).toHaveLength(1)
      expect(markers(a.got)).not.toEqual(markers(b.got))
      expect([...a.got, ...b.got]).not.toContain('outside every request')
    } finally {
      await a.close()
      await b.close()
    }
  })

  it('delivers nothing to a call that did not opt in through _meta', async () => {
    const { deps, entered, release } = await gatedDeps()
    const a = await httpClient(deps, MODERN)
    try {
      const call = a.client.callTool(listCall())
      await entered(1)
      release()
      await call
      expect(a.got).toEqual([])
    } finally {
      await a.close()
    }
  })
})

describe('MCP log forwarding over HTTP /mcp, 2025 era', () => {
  it('delivers no record, in-call or otherwise, since JSON mode has no stream for one', async () => {
    const { deps, entered, release } = await gatedDeps()
    const a = await httpClient(deps)
    try {
      // Accepted, and bound to a server discarded with this request.
      await a.client.setLoggingLevel('debug')
      const call = a.client.callTool(listCall())
      await entered(1)
      getLogger('log-forwarding').warning('outside every request')
      release()
      await call
      // Round trips after the emission, so a record on any open stream has
      // had every chance to arrive before the assertion.
      for (let i = 0; i < 5; i++) await a.client.listTools()
      expect(a.got).toEqual([])
    } finally {
      await a.close()
    }
  })
})

describe('MCP log forwarding over stdio', () => {
  it('holds a 2025-era setLevel for the connection and forwards only in-call records', async () => {
    const { deps, entered, release } = await gatedDeps()
    const a = await stdioClient(deps)
    try {
      await a.client.setLoggingLevel('error')
      const quiet = a.client.callTool(listCall())
      await entered(1)
      getLogger('log-forwarding').error('outside every request')
      release()
      await quiet
      expect(a.got).toEqual([])

      await a.client.setLoggingLevel('warning')
      await a.client.callTool(listCall())
      expect(markers(a.got)).toEqual(['in-call-2'])
      expect(a.got).not.toContain('outside every request')
    } finally {
      await a.close()
    }
  })

  it('delivers a modern-era call’s record when it opts in through _meta', async () => {
    const { deps, entered, release } = await gatedDeps()
    const a = await stdioClient(deps, MODERN)
    try {
      const call = a.client.callTool(listCall(LOG_LEVEL_META))
      await entered(1)
      release()
      await call
      expect(markers(a.got)).toEqual(['in-call-1'])
    } finally {
      await a.close()
    }
  })
})
