/**
 * What a subscribe batch does to a stream's document set: readiness a
 * `client_ready` recorded survives a repeat subscribe, and the stream's cap
 * counts what the batch leaves, not what it names on the way.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_DOCS_PER_STREAM } from '@kamiazya/whiteboard-daemon-client/sync-sse-contract'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import { getReadyClientCount } from '../sync-audience.js'
import { resetSyncStreamsForTests } from '../sync-streams.js'
import { createSyncSseRouter } from './sync-sse.js'

// Its own data dir: resolving a workspace handle opens the store, and one
// shared with a file running in parallel waits on that file's lock.
setDataDirForTests(mkdtempSync(join(tmpdir(), 'wb-sse-subscriptions-')))
afterAll(() => resetDataDirForTests())
afterEach(() => resetSyncStreamsForTests())

const SETTLE = 10_000

async function openedRouter() {
  const app = createSyncSseRouter({ workspaceDocuments: { onUpdated: () => () => {} } })
  const res = await app.request('/api/sync/stream')
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const frame = new TextDecoder().decode((await reader.read()).value)
  const { streamId } = JSON.parse(frame.split('data:')[1] ?? '{}') as { streamId: string }
  const post = (route: 'subscribe' | 'message', body: Record<string, unknown>) =>
    app.request(`/api/sync/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ streamId, ...body }),
    })
  return { post, close: () => reader.cancel() }
}

const docs = (n: number) => Array.from({ length: n }, (_, i) => `ws-cap/doc-${i}`)

describe('the sync route applying a subscribe batch', () => {
  it(
    'keeps a document ready when the same key is subscribed again',
    async () => {
      const { post, close } = await openedRouter()
      await post('subscribe', { subscribe: ['ws-again/page'] })
      await post('message', { doc: 'ws-again/page', message: { type: 'client_ready' } })
      expect(getReadyClientCount('ws-again', 'page')).toBe(1)

      await post('subscribe', { subscribe: ['ws-again/page'] })

      expect(getReadyClientCount('ws-again', 'page')).toBe(1)
      await close()
    },
    SETTLE,
  )

  it(
    'does not count a key the same batch subscribes and unsubscribes against the cap',
    async () => {
      const { post, close } = await openedRouter()
      expect((await post('subscribe', { subscribe: docs(MAX_DOCS_PER_STREAM) })).status).toBe(200)

      const net = await post('subscribe', {
        subscribe: ['ws-cap/transient'],
        unsubscribe: ['ws-cap/transient'],
      })

      expect(net.status).toBe(200)
      await close()
    },
    SETTLE,
  )
})
