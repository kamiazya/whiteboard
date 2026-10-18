// Server mode's `/mcp` caller is a member, not the operator: a record logged
// inside their tool call can carry an error's stack, a storage path, or another
// user's ids, so none of it is forwarded to them — the log channel would
// otherwise undo what the tool-error redaction withholds. The local daemon's
// owner, calling the same tool the same way, still gets the record.
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storeMemoryModule } from '../../shared/test-utils/store-memory.module.js'
import { bearerNamesItsSubject, isolatedServerModePeople } from '../_test-server-mode-harness.js'
import type { ServerModeAppOptions } from '../app.js'
import { testDataLayout, withTempDataDir } from '../routes/_test-helpers.js'

const tmp = withTempDataDir('whiteboard-mcp-log-forwarding-server-mode-')
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
const { getLogger } = await import('../log.js')

const MODERN = '2026-07-28'
const PUBLIC_URL = 'https://example.com'
const INTERNAL_PATH = '/srv/whiteboard/tenant/workspaces.db'

let people: ServerModeAppOptions['people']
let disposePeople: () => Promise<void>
beforeEach(async () => {
  ;({ people, dispose: disposePeople } = await isolatedServerModePeople(join(tmp.dir, 'tenant')))
})
afterEach(async () => {
  await disposePeople()
})

/** Deps whose facet registry, read by `wb_facet_list`, logs an Error naming an internal path. */
function loggingDeps(): ServerDeps {
  const base = resolveServerDeps(createContainer(storeMemoryModule))
  return {
    ...base,
    get facetRegistry() {
      getLogger('log-forwarding').error(
        { err: new Error(`ENOENT: no such file, open '${INTERNAL_PATH}'`) },
        'in-call record',
      )
      return base.facetRegistry
    },
  }
}

async function connect(app: ReturnType<typeof createApp>, headers: Record<string, string>) {
  const client = new Client({ name: 'log-forwarding', version: '1' }, {
    versionNegotiation: { mode: { pin: MODERN } },
  } as never)
  const got: string[] = []
  client.setNotificationHandler('notifications/message', (n) => {
    got.push(JSON.stringify(n.params.data))
  })
  const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
    fetch: async (input, init) => {
      const merged = new Headers(init?.headers)
      for (const [k, v] of Object.entries(headers)) merged.set(k, v)
      return await app.request(input instanceof URL ? input.toString() : String(input), {
        ...init,
        headers: merged,
      })
    },
  })
  await client.connect(transport)
  return { client, got, close: () => transport.close() }
}

async function callOptingIn(client: Client) {
  await client.callTool({
    name: 'wb_facet_list',
    arguments: {},
    _meta: { 'io.modelcontextprotocol/logLevel': 'debug' },
  })
  // Round trips after the call, so a forwarded record has had every chance to arrive.
  for (let i = 0; i < 3; i++) await client.listTools()
}

describe('MCP log forwarding on server mode', () => {
  it('forwards no in-call record to a member who opted in', async () => {
    const app = createApp({
      authMode: 'server-mode',
      publicBaseUrl: PUBLIC_URL,
      allowedOrigins: [PUBLIC_URL],
      authStrategy: bearerNamesItsSubject,
      serverDeps: loggingDeps(),
      dataLayout: testDataLayout(),
      people,
      touch: () => {},
      getStatus: () => {
        throw new Error('not read here')
      },
    })
    const member = await connect(app, { authorization: 'Bearer bob', origin: PUBLIC_URL })
    try {
      await callOptingIn(member.client)
      expect(member.got).toEqual([])
    } finally {
      await member.close()
    }
  })

  it('still forwards the same record to the local daemon owner', async () => {
    const app = createApp({
      authMode: 'local-daemon',
      token: 'secret',
      serverDeps: loggingDeps(),
      dataLayout: testDataLayout(),
      touch: vi.fn(),
      getStatus: () => ({ ok: true }),
    } as never)
    const owner = await connect(app, {
      authorization: 'Bearer secret',
      origin: 'http://127.0.0.1:6274',
    })
    try {
      await callOptingIn(owner.client)
      expect(owner.got.some((d) => d.includes('in-call record'))).toBe(true)
    } finally {
      await owner.close()
    }
  })
})
