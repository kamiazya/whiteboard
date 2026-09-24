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
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import { createApp } from '../app.js'
import { captureLogsForTests } from '../log.js'
import { resetSyncStreamsForTests } from './sync-sse.js'
import { subscribedWorkspaceIds } from './ws.js'

// Its own data dir, through the seam every reader goes through: opening a
// stream opens the store, and a store shared with another file running in
// parallel waits on that file's lock until the test times out.
setDataDirForTests(mkdtempSync(join(tmpdir(), 'wb-sse-audience-')))
afterAll(() => resetDataDirForTests())

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

  // Bounded, because every key is checked for membership and every workspace
  // key is followed by the tail on each pass. A real client holds one
  // workspace key plus the documents it has open.
  it('refuses a subscribe that names more keys than a stream may hold', async () => {
    const a = app()
    const streamId = await openStream(a)
    const subscribe = (keys: string[]) =>
      a.request('/api/sync/subscribe', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId, subscribe: keys }),
      })
    const keys = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `ws-1/doc-${from + i}`)

    expect((await subscribe(keys(0, 257))).status).toBe(400)
    expect((await subscribe(keys(0, 256))).status).toBe(200)
    const over = await subscribe(keys(256, 1))
    expect(over.status).toBe(400)
    expect(await over.json()).toEqual({ error: 'too_many_subscriptions' })
  })
})
