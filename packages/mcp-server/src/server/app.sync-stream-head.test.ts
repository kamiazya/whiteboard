/**
 * The composed local daemon opens the sync stream for GET alone. Hono answers
 * HEAD by running the GET handler and dropping the body, so a stream it opened
 * would have no reader to end it and would stay registered for good; every
 * other method gets the same 405 rather than a route-less 404.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createContainer, resolveServerDeps } from '../di/container.js'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import {
  bearerNamesItsSubject,
  isolatedServerModePeople,
  PUBLIC_URL,
} from './_test-server-mode-harness.js'
import { createApp } from './app.js'
import { resolveTestServerDeps, testDataLayout } from './routes/_test-helpers.js'
import { openSyncStreamCount, resetSyncStreamsForTests } from './sync-streams.js'

const dataDir = mkdtempSync(join(tmpdir(), 'wb-sync-stream-head-'))
setDataDirForTests(dataDir)
afterAll(() => {
  resetDataDirForTests()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
let serverDeps: ServerDeps
let serverModeApp: ReturnType<typeof createApp>
let disposePeople: () => Promise<void>
beforeAll(async () => {
  serverDeps = await resolveTestServerDeps(dataDir)
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
afterEach(() => resetSyncStreamsForTests())

const TOKEN = 'sync-stream-head-test-token'

function localDaemonApp() {
  return createApp({
    authMode: 'local-daemon' as const,
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({ port: 3099 }) as never,
    serverDeps,
    dataLayout: testDataLayout(),
  })
}

it.each([
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
])('answers %s on the sync stream with 405 and registers no stream', async (method) => {
  const res = await localDaemonApp().request('/api/sync/stream', {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('GET')
  expect(openSyncStreamCount()).toBe(0)
})

it.each([
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
])('answers %s on the sync stream in server mode with 405', async (method) => {
  const res = await serverModeApp.request(`${PUBLIC_URL}/api/sync/stream`, {
    method,
    headers: { authorization: 'Bearer ada', origin: PUBLIC_URL },
  })
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('GET')
  expect(openSyncStreamCount()).toBe(0)
})
