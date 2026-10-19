/**
 * What a subscribe batch does to a stream's document set: readiness a
 * `client_ready` recorded survives a repeat subscribe, and the stream's cap
 * counts what the batch leaves, not what it names on the way.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_DOCS_PER_STREAM } from '@kamiazya/whiteboard-daemon-client/sync-sse-contract'
import { DOCUMENT_PATH_MAX_LENGTH, WORKSPACE_SEGMENT_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import { getReadyClientCount } from '../sync-audience.js'
import { resetSyncStreamsForTests } from '../sync-streams.js'
import { createSyncSseRouter } from './sync-sse.js'

// Its own data dir: resolving a workspace handle opens the store, and one
// shared with a file running in parallel waits on that file's lock.
const dataDir = mkdtempSync(join(tmpdir(), 'wb-sse-subscriptions-'))
setDataDirForTests(dataDir)
afterAll(() => {
  resetDataDirForTests()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
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

  it(
    'lets a full stream subscribe again to a document it already holds',
    async () => {
      const { post, close } = await openedRouter()
      expect((await post('subscribe', { subscribe: docs(MAX_DOCS_PER_STREAM) })).status).toBe(200)

      const held = await post('subscribe', { subscribe: ['ws-cap/doc-0'] })
      const fresh = await post('subscribe', { subscribe: ['ws-cap/beyond'] })

      expect(held.status).toBe(200)
      expect(fresh.status).toBe(400)
      await close()
    },
    SETTLE,
  )
})

describe('the sync route recording readiness', () => {
  const ready = (doc: string) => ({ doc, message: { type: 'client_ready' } })

  it(
    'refuses a client_ready past the stream cap and keeps the set at the cap',
    async () => {
      const { post, close } = await openedRouter()
      for (const doc of docs(MAX_DOCS_PER_STREAM)) {
        expect((await post('message', ready(doc))).status).toBe(200)
      }

      const beyond = await post('message', ready('ws-cap/beyond'))
      const held = await post('message', ready('ws-cap/doc-0'))
      const now = (await (await post('subscribe', {})).json()) as { docs: string[] }

      expect(beyond.status).toBe(400)
      expect(await beyond.json()).toEqual({ error: 'too_many_subscriptions' })
      expect(held.status).toBe(200)
      expect(now.docs).toHaveLength(MAX_DOCS_PER_STREAM)
      expect(now.docs).not.toContain('ws-cap/beyond')
      await close()
    },
    SETTLE,
  )
})

describe('the sync route bounding the doc keys it holds', () => {
  const overLong = `${'h'.repeat(WORKSPACE_SEGMENT_MAX_LENGTH)}/${'p'.repeat(DOCUMENT_PATH_MAX_LENGTH + 1)}`

  it.each([
    ['an over-long subscribe', 'subscribe', { subscribe: [overLong] }],
    ['an over-long unsubscribe', 'subscribe', { unsubscribe: [overLong] }],
    ['an over-long client_ready', 'message', { doc: overLong, message: { type: 'client_ready' } }],
    [
      'a client_ready naming no workspace',
      'message',
      { doc: 'no-workspace-named', message: { type: 'client_ready' } },
    ],
  ] as const)(
    'refuses %s as an invalid body',
    async (_, route, body) => {
      const { post, close } = await openedRouter()
      const res = await post(route, body)

      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('invalid_request')
      const now = (await (await post('subscribe', {})).json()) as { docs: string[] }
      expect(now.docs).toEqual([])
      await close()
    },
    SETTLE,
  )
})
