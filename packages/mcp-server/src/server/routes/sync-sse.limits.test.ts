/**
 * What one caller can make the shared keeper hold for its sync streams: how
 * many streams, how much undelivered data down each, and how much across all
 * of one user's streams and all of the instance's.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import {
  MAX_QUEUED_STREAM_CHARS,
  openSyncStreamCount,
  resetSyncStreamsForTests,
  sseBroadcastWorkspaceUpdate,
  syncStreamById,
} from '../sync-streams.js'
import { createSyncSseRouter, type SyncSseRouterOptions } from './sync-sse.js'

// Its own data dir: resolving a workspace handle opens the store, and one
// shared with a file running in parallel waits on that file's lock.
const dataDir = mkdtempSync(join(tmpdir(), 'wb-sse-limits-'))
setDataDirForTests(dataDir)
afterAll(() => {
  resetDataDirForTests()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
afterEach(() => resetSyncStreamsForTests())

type Router = ReturnType<typeof createSyncSseRouter>

function router(extra: Partial<SyncSseRouterOptions> = {}): Router {
  return createSyncSseRouter({ workspaceDocuments: { onUpdated: () => () => {} }, ...extra })
}

/** The caller names its user in a header, standing in for a session. */
const userFromHeader = {
  userOf: async (c: { req: { header: (name: string) => string | undefined } }) =>
    c.req.header('x-user') ?? null,
}

async function open(app: Router, user?: string) {
  const res = await app.request('/api/sync/stream', {
    headers: user === undefined ? {} : { 'x-user': user },
  })
  if (res.status !== 200) return { res, streamId: null, reader: null }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const frame = new TextDecoder().decode((await reader.read()).value)
  const { streamId } = JSON.parse(frame.split('data:')[1] ?? '{}') as { streamId: string }
  return { res, streamId, reader }
}

describe('how many sync streams the keeper holds open', () => {
  it('refuses one user past their stream cap, and nobody else', async () => {
    const app = router({ ...userFromHeader, streamCaps: { perUser: 2, total: 10 } })
    expect((await open(app, 'bob')).res.status).toBe(200)
    expect((await open(app, 'bob')).res.status).toBe(200)

    const refused = await open(app, 'bob')
    expect(refused.res.status).toBe(429)
    expect(await refused.res.json()).toMatchObject({ error: 'too_many_streams' })
    expect(refused.res.headers.get('retry-after')).toBeTruthy()
    expect((await open(app, 'ada')).res.status).toBe(200)
  })

  it('refuses everyone once the keeper holds its total', async () => {
    const app = router({ ...userFromHeader, streamCaps: { perUser: 5, total: 2 } })
    expect((await open(app, 'bob')).res.status).toBe(200)
    expect((await open(app, 'ada')).res.status).toBe(200)

    expect((await open(app, 'eve')).res.status).toBe(429)
  })

  // A page that goes away before taking its first frame must not leave a
  // stream registered against its user's cap for good.
  it('forgets a stream whose page closed before reading its first frame', async () => {
    const app = router({ ...userFromHeader, streamCaps: { perUser: 1, total: 10 } })
    const res = await app.request('/api/sync/stream', { headers: { 'x-user': 'bob' } })
    await (res.body as ReadableStream<Uint8Array>).cancel()
    await expect.poll(() => openSyncStreamCount()).toBe(0)
    expect((await open(app, 'bob')).res.status).toBe(200)
  })

  it('admits a user again once one of their streams closes', async () => {
    const app = router({ ...userFromHeader, streamCaps: { perUser: 1, total: 10 } })
    const first = await open(app, 'bob')
    expect((await open(app, 'bob')).res.status).toBe(429)

    await first.reader?.cancel()
    await expect.poll(() => syncStreamById(first.streamId as string)).toBeUndefined()
    expect((await open(app, 'bob')).res.status).toBe(200)
  })
})

/** A stream subscribed to one workspace record, and the broadcasts that,
 *  left unread, would pass the ceiling with one to spare. */
async function subscribedStream(workspaceId: string) {
  const app = router()
  const { streamId, reader } = await open(app)
  const subscribed = await app.request('/api/sync/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streamId, subscribe: [`workspace:${workspaceId}`] }),
  })
  expect(subscribed.status).toBe(200)
  if (streamId === null || reader === null) throw new Error('stream refused')
  return { streamId, reader }
}

// Base64 makes each 3 bytes 4 characters.
const UPDATE = new Uint8Array(4 * 1024 * 1024)
const PAST_CEILING = Math.ceil(MAX_QUEUED_STREAM_CHARS / ((UPDATE.byteLength / 3) * 4)) + 1

/** Each broadcast from its own turn of the loop, as commits arrive: a write
 *  the reader takes has every chance to settle in between. */
async function broadcastPastCeiling(workspaceId: string) {
  for (let i = 0; i < PAST_CEILING; i++) {
    sseBroadcastWorkspaceUpdate(workspaceId, UPDATE)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('what a stream that is not being read is allowed to queue', () => {
  it('ends a stream whose undelivered frames pass the ceiling', async () => {
    const { streamId, reader } = await subscribedStream('ws-unread')

    await broadcastPastCeiling('ws-unread')

    expect(syncStreamById(streamId)).toBeUndefined()
    await reader.cancel().catch(() => {})
  })

  it('keeps a stream whose reader takes the same frames as they come', async () => {
    const { streamId, reader } = await subscribedStream('ws-read')
    let drained = true
    const draining = (async () => {
      while (!(await reader.read()).done) {}
    })().catch(() => {
      drained = false
    })

    await broadcastPastCeiling('ws-read')

    expect(syncStreamById(streamId)).toBeDefined()
    await reader.cancel().catch(() => {})
    await draining
    expect(drained).toBe(true)
  })
})

/** A stream of `user` subscribed to one workspace record, left unread. */
async function unreadStreamOf(app: Router, user: string, workspaceId: string) {
  const { streamId, reader } = await open(app, user)
  if (streamId === null || reader === null) throw new Error('stream refused')
  const subscribed = await app.request('/api/sync/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user': user },
    body: JSON.stringify({ streamId, subscribe: [`workspace:${workspaceId}`] }),
  })
  expect(subscribed.status).toBe(200)
  return { streamId, reader }
}

const SMALL_UPDATE = new Uint8Array(96 * 1024)
/** The characters one SMALL_UPDATE frame queues, envelope aside. */
const SMALL_FRAME_CHARS = Math.ceil(SMALL_UPDATE.byteLength / 3) * 4

// Three unread streams under a budget of ten frames: five broadcasts put
// three streams past it and leave two under, whether or not a stream's first
// unread write settles into the response's own buffer.
const BUDGET_FRAMES = 10
const PAST_BUDGET_BROADCASTS = 5

async function broadcastSmall(workspaceId: string, times: number) {
  for (let i = 0; i < times; i++) {
    sseBroadcastWorkspaceUpdate(workspaceId, SMALL_UPDATE)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

// Each stream stays under its own ceiling, so only a budget across streams
// bounds what a user opening many and reading none makes the keeper hold.
describe('what all of one user’s unread streams may queue together', () => {
  it('ends that user’s oldest stream once their streams together pass the budget, and nobody else’s', async () => {
    const app = router({
      ...userFromHeader,
      streamCaps: { perUser: 8, total: 32 },
      queueBudget: { perUser: BUDGET_FRAMES * SMALL_FRAME_CHARS, total: 1_000 * SMALL_FRAME_CHARS },
    })
    // Opened first, so the instance's oldest stream is not the one to end.
    const ada = await unreadStreamOf(app, 'ada', 'ws-budget')
    const oldest = await unreadStreamOf(app, 'bob', 'ws-budget')
    const newer = await unreadStreamOf(app, 'bob', 'ws-budget')
    const newest = await unreadStreamOf(app, 'bob', 'ws-budget')

    await broadcastSmall('ws-budget', PAST_BUDGET_BROADCASTS)

    expect(syncStreamById(oldest.streamId)).toBeUndefined()
    expect(syncStreamById(newer.streamId)).toBeDefined()
    expect(syncStreamById(newest.streamId)).toBeDefined()
    expect(syncStreamById(ada.streamId)).toBeDefined()
    for (const { reader } of [oldest, newer, newest, ada]) await reader.cancel().catch(() => {})
  })

  it('ends the instance’s oldest unread stream once every stream together passes its budget', async () => {
    const app = router({
      ...userFromHeader,
      streamCaps: { perUser: 8, total: 32 },
      queueBudget: { perUser: 1_000 * SMALL_FRAME_CHARS, total: BUDGET_FRAMES * SMALL_FRAME_CHARS },
    })
    const bob = await unreadStreamOf(app, 'bob', 'ws-total')
    const ada = await unreadStreamOf(app, 'ada', 'ws-total')
    const eve = await unreadStreamOf(app, 'eve', 'ws-total')

    await broadcastSmall('ws-total', PAST_BUDGET_BROADCASTS)

    expect(syncStreamById(bob.streamId)).toBeUndefined()
    expect(syncStreamById(ada.streamId)).toBeDefined()
    expect(syncStreamById(eve.streamId)).toBeDefined()
    for (const { reader } of [bob, ada, eve]) await reader.cancel().catch(() => {})
  })

  it('keeps every stream whose reader takes its frames, however many there are', async () => {
    const app = router({
      ...userFromHeader,
      streamCaps: { perUser: 8, total: 32 },
      queueBudget: {
        perUser: BUDGET_FRAMES * SMALL_FRAME_CHARS,
        total: BUDGET_FRAMES * SMALL_FRAME_CHARS,
      },
    })
    const streams = [
      await unreadStreamOf(app, 'bob', 'ws-drained'),
      await unreadStreamOf(app, 'bob', 'ws-drained'),
      await unreadStreamOf(app, 'bob', 'ws-drained'),
    ]
    const draining = streams.map(({ reader }) =>
      (async () => {
        while (!(await reader.read()).done) {}
      })().catch(() => {}),
    )

    await broadcastSmall('ws-drained', 12)

    for (const { streamId } of streams) expect(syncStreamById(streamId)).toBeDefined()
    for (const { reader } of streams) await reader.cancel().catch(() => {})
    await Promise.all(draining)
  })
})
