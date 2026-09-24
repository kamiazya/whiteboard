/**
 * Two things several instances need from the SSE transport (ADR-0020):
 * the workspace tail follows a workspace only while it has an audience on
 * this instance, so a stream's subscriptions have to count as one; and a
 * request for a stream another instance holds has to be visible, because
 * it means the load balancer is not keeping a browser on one instance.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Its own data dir: the app opens the store, and sharing the default one with
// another file running in parallel is a locked database.
const dataDir = mkdtempSync(join(tmpdir(), 'wb-sse-audience-'))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  get DATA_DIR() {
    return dataDir
  },
  getDataDir: () => dataDir,
}))

const { createApp } = await import('../app.js')
const { captureLogsForTests } = await import('../log.js')
const { resetSyncStreamsForTests } = await import('./sync-sse.js')
const { subscribedWorkspaceIds } = await import('./ws.js')

afterEach(() => resetSyncStreamsForTests())

const TOKEN = 'sse-audience-test-token'
const auth = { Authorization: `Bearer ${TOKEN}` }

function app() {
  return createApp({
    authMode: 'local-daemon' as const,
    token: TOKEN,
    touch: () => {},
    getStatus: () => ({ port: 3099 }) as never,
  })
}

async function openStream(a: ReturnType<typeof app>): Promise<string> {
  const res = await a.request('/api/sync/stream', { headers: auth })
  const reader = res.body?.getReader()
  if (!reader) throw new Error('no stream body')
  const { value } = await reader.read()
  reader.releaseLock()
  const data = new TextDecoder()
    .decode(value)
    .split('\n')
    .find((l) => l.startsWith('data:'))
    ?.slice(5)
  return JSON.parse(data ?? '{}').streamId
}

describe('the SSE transport and several instances', () => {
  it('counts a workspace a stream subscribed to as having an audience here', async () => {
    const a = app()
    const streamId = await openStream(a)
    await a.request('/api/sync/subscribe', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      // A per-document key carries text only; the workspace record is what
      // the tail follows, so only the workspace key is an audience for it.
      body: JSON.stringify({ streamId, subscribe: ['workspace:ws-1', 'ws-2/a'] }),
    })
    expect(subscribedWorkspaceIds()).toEqual(['ws-1'])
  })

  it('warns when asked about a stream this instance does not hold', async () => {
    const logs = captureLogsForTests('warning')
    try {
      const res = await app().request('/api/sync/subscribe', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId: 'held-elsewhere', subscribe: ['workspace:ws-1'] }),
      })
      expect(res.status).toBe(404)
      expect(logs.records.some((r) => /sticky/i.test(String(r.msg)))).toBe(true)
    } finally {
      logs.restore()
    }
  })
})
