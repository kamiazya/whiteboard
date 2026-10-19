/**
 * The composed local daemon refuses HEAD on the sync stream. Hono answers HEAD
 * by running the GET handler and dropping the body, so a stream it opened
 * would have no reader to end it and would stay registered for good.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../shared/data-dir-secure.js'
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
beforeAll(async () => {
  serverDeps = await resolveTestServerDeps(dataDir)
})
afterEach(() => resetSyncStreamsForTests())

const TOKEN = 'sync-stream-head-test-token'

it('answers HEAD on the sync stream with 405 and registers no stream', async () => {
  const app = createApp({
    authMode: 'local-daemon' as const,
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({ port: 3099 }) as never,
    serverDeps,
    dataLayout: testDataLayout(),
  })
  const res = await app.request('/api/sync/stream', {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  expect(res.status).toBe(405)
  expect(res.headers.get('allow')).toBe('GET')
  expect(openSyncStreamCount()).toBe(0)
})
