/**
 * Server mode's `/mcp` streams that carry no tool call. Each one keeps a
 * whole MCP server alive for as long as the client holds it, and none of
 * them is a content-sized request, so the content slots do not count them:
 * a legacy GET stream is refused outright — the transport is stateless and
 * has nothing to push down it — and `subscriptions/listen` streams are held
 * to a per-user and per-instance cap, released as each ends.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import {
  bearerNamesItsSubject,
  ISSUER,
  PUBLIC_URL,
  serverModePeople,
} from './_test-server-mode-harness.js'
import type { ServerModeAppOptions } from './app.js'
import { MCP_LISTEN_STREAM_CAPS } from './mcp-listen-streams.js'
import { testDataLayout } from './routes/_test-helpers.js'
import { createIsolatedDb } from './store/db/test-helpers.js'

let tempDir: string

vi.mock('./config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
  DIST_WEB_APP_DIR: '/tmp/whiteboard/dist/web-app',
}))

const { createApp } = await import('./app.js')

const MODERN = '2026-07-28'

let handle: Awaited<ReturnType<typeof createIsolatedDb>>
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'wb-server-mode-mcp-stream-cap-'))
  handle = await createIsolatedDb({ dataDir: tempDir })
  const stores = serverModePeople(handle.db, tempDir)
  for (const subject of ['ada', 'bob']) {
    await stores.members.ensureProfile({
      binding: { authenticator: ISSUER, subject },
      displayName: subject,
    })
  }
  const options: ServerModeAppOptions = {
    authMode: 'server-mode',
    publicBaseUrl: PUBLIC_URL,
    allowedOrigins: [PUBLIC_URL],
    authStrategy: bearerNamesItsSubject,
    serverDeps: resolveServerDeps(createContainer(storeMemoryModule)),
    dataLayout: testDataLayout(),
    people: stores.people,
    touch: () => {},
    getStatus: () => {
      throw new Error('not read by these routes')
    },
  }
  app = createApp(options)
})
afterEach(async () => {
  await handle.dispose()
  await rm(tempDir, { recursive: true, force: true })
})

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

function listen(subject: string) {
  return Promise.resolve(
    app.request(`${PUBLIC_URL}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${subject}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': 'subscriptions/listen',
        'mcp-protocol-version': MODERN,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        params: { notifications: {}, _meta: MODERN_META },
      }),
    }),
  )
}

/**
 * One after another: opening many at once would meet the content slots each
 * listen request holds while it is read, which are not what is under test.
 */
async function openListens(subject: string, count: number): Promise<Response[]> {
  const streams: Response[] = []
  for (let i = 0; i < count; i += 1) {
    const stream = await listen(subject)
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    streams.push(stream)
  }
  return streams
}

const cancelAll = (streams: readonly Response[]) =>
  Promise.all(streams.map((stream) => stream.body?.cancel('client went away')))

describe('server mode — /mcp streams that carry no tool call', () => {
  it('refuses a legacy GET stream with 405, naming POST as what /mcp takes', async () => {
    const res = await app.request(`${PUBLIC_URL}/mcp`, {
      method: 'GET',
      headers: { authorization: 'Bearer ada', accept: 'text/event-stream' },
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toContain('POST')
    expect(res.headers.get('content-type')).not.toContain('text/event-stream')
  })

  it('holds one user to the per-user cap on listen streams, and frees a place as one ends', async () => {
    const held = await openListens('ada', MCP_LISTEN_STREAM_CAPS.perUser)
    try {
      const refused = await listen('ada')
      expect(refused.status).toBe(429)
      expect(refused.headers.get('content-type')).not.toContain('text/event-stream')

      // Another person is not held to ada's count.
      const bobs = await openListens('bob', 1)
      await cancelAll(bobs)

      await held[0]?.body?.cancel('client went away')
      const next = await openListens('ada', 1)
      held.push(...next)
    } finally {
      await cancelAll(held.slice(1))
    }
  })
})
