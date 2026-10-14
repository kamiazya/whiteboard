// @vitest-environment node
/**
 * How long the worker waits between attempts at work the daemon keeps
 * failing: re-sending an outstanding write, and re-fetching the snapshot a
 * refused write's replica is rebuilt from. Both double from one second and
 * stop doubling at thirty, so a daemon that is down for an hour is asked about
 * once every thirty seconds rather than at an ever-growing interval, and a
 * blip of a second costs a second rather than a long wait.
 *
 * Driven on fake `setTimeout` alone. `@vitest/web-worker` runs the worker in
 * this realm, so its timers ARE the faked ones, while the I/O the worker
 * waits on between them — MSW, the stream, the message ports — runs for real.
 * That is why the waits below poll on `setImmediate` and not through
 * `vi.waitFor`, which advances fake time on every poll and would move the
 * very clock these cases read.
 *
 * Its own file for the reason its siblings are: one replica-capable worker
 * per realm (see `sse-shared-worker-resend.test.ts`).
 */
import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import '@vitest/web-worker'
import { LoroDoc } from 'loro-crdt'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const BASE = 'http://127.0.0.1:3099'

let streamSeq = 0
const subscribeBodies: string[] = []
/** Docs whose every write the daemon fails with a 503 — a daemon that is down. */
const unavailableFor = new Set<string>()
/** Docs whose every write the daemon refuses for its bytes. */
const refusedFor = new Set<string>()
/** Docs whose snapshot fetch answers 503. */
const snapshotDownFor = new Set<string>()
const writeAttempts = new Map<string, number>()
const snapshotAttempts = new Map<string, number>()

const docOf = (params: Record<string, unknown>) =>
  `${String(params.workspaceId)}/${String(params.path)}`
const bump = (counts: Map<string, number>, doc: string) =>
  counts.set(doc, (counts.get(doc) ?? 0) + 1)

const server = setupServer(
  http.get(`${BASE}/api/sync/stream`, () => {
    streamSeq += 1
    const id = `backoff-${streamSeq}`
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`event: ready\ndata: ${JSON.stringify({ streamId: id })}\n\n`),
        )
      },
    })
    return new HttpResponse(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }),
  http.post(`${BASE}/api/sync/subscribe`, async ({ request }) => {
    subscribeBodies.push(await request.text())
    return HttpResponse.json({ ok: true })
  }),
  http.get(`${BASE}/api/w/:workspaceId/document/:path/snapshot`, ({ params }) => {
    const doc = docOf(params)
    bump(snapshotAttempts, doc)
    if (snapshotDownFor.has(doc)) return new HttpResponse('restarting', { status: 503 })
    return HttpResponse.json({ title: 'Canvas not found' }, { status: 404 })
  }),
  http.post(`${BASE}/api/w/:workspaceId/document/:path/update`, ({ params }) => {
    const doc = docOf(params)
    bump(writeAttempts, doc)
    if (unavailableFor.has(doc)) return new HttpResponse('restarting', { status: 503 })
    if (refusedFor.has(doc))
      return HttpResponse.json(
        { error: 'markdown_too_large', message: 'past the limit for one document' },
        { status: 413 },
      )
    return HttpResponse.json({ ok: true })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())
afterEach(() => vi.useRealTimers())

let docSeq = 0
const nextDoc = () => `backoff-ws/doc-${++docSeq}`

let port: MessagePort
beforeAll(() => {
  const worker = new SharedWorker(new URL('./sse-shared-worker.ts', import.meta.url), {
    type: 'module',
  })
  port = worker.port
  port.start()
  port.postMessage({ type: 'init', baseUrl: BASE })
})

/**
 * Polls `predicate` between macrotasks on `setImmediate`, which the fake
 * clock leaves real, against a wall-clock deadline (`Date` is not faked
 * either). Never advances the fake clock.
 */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function subscribed(doc: string): Promise<void> {
  port.postMessage({ type: 'subscribe', doc })
  await until(
    () =>
      subscribeBodies.some((b) => b.includes(`"subscribe":["${doc}"]`)) &&
      (snapshotAttempts.get(doc) ?? 0) >= 1,
    `${doc} to be subscribed and seeded`,
  )
}

function pushEdit(doc: string): void {
  const tab = new LoroDoc()
  tab.getMap('m').set('edit', doc)
  tab.commit()
  port.postMessage({ type: 'push', doc, update: bytesToBase64(tab.export({ mode: 'update' })) })
}

/** Doubling from one second, held at thirty once doubling would pass it. */
const EXPECTED_DELAYS_MS = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]

/**
 * Walks the retry schedule: each attempt must not come one millisecond early,
 * and must come on time. `attempts` reads the daemon-side count; one fake timer
 * pending means the worker has re-armed after the attempt before.
 */
async function expectSchedule(attempts: () => number, what: string): Promise<void> {
  for (const [index, delay] of EXPECTED_DELAYS_MS.entries()) {
    const before = attempts()
    vi.advanceTimersByTime(delay - 1)
    expect(attempts(), `${what} ${index + 1} fired before ${delay}ms`).toBe(before)
    expect(vi.getTimerCount(), `${what} ${index + 1} fired before ${delay}ms`).toBe(1)
    vi.advanceTimersByTime(1)
    await until(
      () => attempts() === before + 1 && vi.getTimerCount() === 1,
      `${what} ${index + 1} after ${delay}ms`,
    )
  }
}

describe('retry backoff', { timeout: 60_000 }, () => {
  it('re-sends a failing write after doubling waits capped at thirty seconds', async () => {
    const doc = nextDoc()
    await subscribed(doc)
    unavailableFor.add(doc)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    pushEdit(doc)
    await until(
      () => writeAttempts.get(doc) === 1 && vi.getTimerCount() === 1,
      'the first write to fail and arm its retry',
    )
    await expectSchedule(() => writeAttempts.get(doc) ?? 0, 'write retry')
  })

  it('re-fetches a refused write’s snapshot after doubling waits capped at thirty seconds', async () => {
    const doc = nextDoc()
    await subscribed(doc)
    const seeds = snapshotAttempts.get(doc) ?? 0
    refusedFor.add(doc)
    snapshotDownFor.add(doc)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    pushEdit(doc)
    await until(
      () => snapshotAttempts.get(doc) === seeds + 1 && vi.getTimerCount() === 1,
      'the first replacement snapshot to fail and arm its retry',
    )
    await expectSchedule(() => snapshotAttempts.get(doc) ?? 0, 'snapshot retry')
    // Refused bytes are never offered again while the replica is rebuilt.
    expect(writeAttempts.get(doc)).toBe(1)
  })
})
