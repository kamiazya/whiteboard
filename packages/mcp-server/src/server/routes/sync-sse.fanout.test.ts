/**
 * What one workspace update costs the keeper to fan out: how many times the
 * frame is serialised, against how many streams follow it.
 *
 * A workspace update may be as large as the content body limit, and travels
 * base64-encoded — a 16 MiB update is a string of about 22 MB. Each
 * serialisation of the frame is another string, or another byte array, that
 * size.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import {
  resetSyncStreamsForTests,
  sseBroadcastWorkspaceUpdate,
  syncStreamById,
} from '../sync-streams.js'
import { resolveTestServerDeps } from './_test-helpers.js'
import { createSyncSseRouter, type SyncSseRouterOptions } from './sync-sse.js'

// Its own data dir: resolving a workspace handle opens the store, and one
// shared with a file running in parallel waits on that file's lock.
const dataDir = mkdtempSync(join(tmpdir(), 'wb-sse-fanout-'))
setDataDirForTests(dataDir)
afterAll(() => {
  resetDataDirForTests()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
afterEach(() => {
  vi.restoreAllMocks()
  resetSyncStreamsForTests()
})

type Router = ReturnType<typeof createSyncSseRouter>

function router(extra: Partial<SyncSseRouterOptions> = {}): Router {
  return createSyncSseRouter({ workspaceDocuments: { onUpdated: () => () => {} }, ...extra })
}

/** A stream subscribed under `keys`, and a reader that collects its frames as text. */
async function subscribedStream(app: Router, keys: readonly string[]) {
  const res = await app.request('/api/sync/stream')
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let text = decoder.decode((await reader.read()).value)
  const { streamId } = JSON.parse(text.split('data:')[1] ?? '{}') as { streamId: string }
  text = ''
  const subscribed = await app.request('/api/sync/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streamId, subscribe: keys }),
  })
  expect(subscribed.status).toBe(200)
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      text += decoder.decode(value, { stream: true })
    }
  })().catch(() => {})
  return {
    /** The complete `update` frames read so far, as `event`/`data` text. */
    updates: () => text.split('\n\n').filter((frame) => frame.startsWith('event: update\n')),
    close: async () => {
      await reader.cancel().catch(() => {})
      await reading
    },
  }
}

/**
 * Counts every whole-frame serialisation that carries `base64`: a
 * `JSON.stringify` of the payload, and a text-to-bytes encode of it.
 */
function countSerialisations(base64: string): () => number {
  let count = 0
  const stringify = JSON.stringify
  vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: never[]) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as { update?: unknown }).update === base64
    ) {
      count++
    }
    return stringify(value, ...rest)
  }) as typeof JSON.stringify)
  const encode = TextEncoder.prototype.encode
  vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
    this: TextEncoder,
    input?: string,
  ) {
    if (input?.includes(base64)) count++
    return encode.call(this, input)
  })
  return () => count
}

const STREAMS = 4
// Large enough that its base64 cannot occur by chance in anything else.
const UPDATE = new Uint8Array(64 * 1024).map((_, i) => (i * 31) % 251)
const UPDATE_BASE64 = Buffer.from(UPDATE).toString('base64')

describe('fanning one workspace update out to many streams', () => {
  it('serialises the update once, however many streams follow the workspace', async () => {
    const app = router()
    const streams = []
    for (let i = 0; i < STREAMS; i++) {
      streams.push(await subscribedStream(app, ['workspace:ws-fanout']))
    }
    const serialisations = countSerialisations(UPDATE_BASE64)

    sseBroadcastWorkspaceUpdate('ws-fanout', UPDATE)

    for (const stream of streams) await expect.poll(() => stream.updates().length).toBe(1)
    for (const stream of streams) {
      const data = JSON.parse(stream.updates()[0]?.split('\ndata: ')[1] ?? '{}')
      expect(data).toEqual({ doc: 'workspace:ws-fanout', update: UPDATE_BASE64 })
    }
    // One byte array, shared by every stream's queue.
    expect(serialisations()).toBe(1)
    for (const stream of streams) await stream.close()
  })
})

/** The characters one UPDATE's payload queues, envelope aside. */
const UPDATE_CHARS = UPDATE_BASE64.length

/** A stream of `user` subscribed under `keys`, left unread. */
async function unreadStreamOf(app: Router, user: string, keys: readonly string[]) {
  const res = await app.request('/api/sync/stream', { headers: { 'x-user': user } })
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const ready = new TextDecoder().decode((await reader.read()).value)
  const { streamId } = JSON.parse(ready.split('data:')[1] ?? '{}') as { streamId: string }
  const subscribed = await app.request('/api/sync/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user': user },
    body: JSON.stringify({ streamId, subscribe: keys }),
  })
  expect(subscribed.status).toBe(200)
  return { streamId, reader }
}

// A stream may follow one workspace under several handles — its id and its
// segment, from two tabs sharing the stream — and the page routes each frame
// by the spelling it subscribed with, so each spelling still needs its own
// frame. The payload is the same bytes for both, and is queued once.
describe('one workspace followed under two spellings on one stream', () => {
  it('queues the update once for both spellings', async () => {
    const deps = await resolveTestServerDeps(dataDir)
    await deps.documentIndex.createWorkspace({ workspaceId: 'ws-two-spellings', segment: 'twice' })
    // Room for three copies of the payload, not for five: three broadcasts
    // left unread queue two once the first is taken into the response's
    // buffer, or five when each spelling's frame is queued apart.
    const app = router({
      userOf: async (c) => c.req.header('x-user') ?? null,
      queueBudget: { perUser: 3 * UPDATE_CHARS, total: 1_000 * UPDATE_CHARS },
    })
    const { streamId, reader } = await unreadStreamOf(app, 'bob', [
      'workspace:ws-two-spellings',
      'workspace:twice',
    ])

    for (let i = 0; i < 3; i++) {
      sseBroadcastWorkspaceUpdate('ws-two-spellings', UPDATE)
      await new Promise((resolve) => setImmediate(resolve))
    }

    expect(syncStreamById(streamId)).toBeDefined()
    // Both spellings are still delivered, each under its own key.
    const decoder = new TextDecoder()
    let text = ''
    // Every part before the last `\n\n` is a whole frame.
    const updates = () =>
      text
        .split('\n\n')
        .slice(0, -1)
        .filter((frame) => frame.startsWith('event: update\n'))
    while (updates().length < 6) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
    const docs = updates().map((frame) => JSON.parse(frame.split('\ndata: ')[1] ?? '{}').doc)
    expect(docs.filter((doc) => doc === 'workspace:ws-two-spellings')).toHaveLength(3)
    expect(docs.filter((doc) => doc === 'workspace:twice')).toHaveLength(3)
    await reader.cancel().catch(() => {})
  })
})
