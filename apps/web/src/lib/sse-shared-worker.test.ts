/**
 * Drives the real SharedWorker module through its real `onconnect` entry via
 * @vitest/web-worker, with MSW standing in for the daemon. Nothing reaches into
 * the worker's internals: the production construction path is what is worth
 * covering, and a test-only export would be a seam the app does not need.
 *
 * What this cannot cover: sharing BETWEEN tabs. The polyfill builds a fresh
 * worker context per `new SharedWorker`, so two ports here are two workers, not
 * two tabs of one — asserting cross-port refcounting would pass or fail for
 * reasons that say nothing about a browser. That stays a real-browser concern.
 * What it does cover is everything decided inside one worker: how many streams
 * it opens and how it routes frames per document.
 *
 * Deliberately NOT covered: that a subscribe arriving before init is dropped.
 * That is an absence, and a SharedWorker cannot be terminated, so earlier
 * tests' workers keep running and the environment never quiesces enough to
 * observe it deterministically. A test that cannot be made deterministic is
 * worse than none.
 */
import '@vitest/web-worker'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const BASE = 'http://127.0.0.1:3099'

let streamOpens = 0
let subscribeBodies: string[] = []
let pushFrame: ((frame: string) => void) | null = null

const server = setupServer(
  http.get(`${BASE}/api/sync/stream`, () => {
    streamOpens += 1
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        pushFrame = (f) => controller.enqueue(enc.encode(f))
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
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())
beforeEach(() => {
  streamOpens = 0
  subscribeBodies = []
  pushFrame = null
})
afterEach(() => server.resetHandlers())

// A SharedWorker cannot be terminated, so workers from earlier tests stay
// alive and can still emit a late subscribe. Unique document ids per test keep
// one test's traffic from being read as another's.
let docSeq = 0
const nextDoc = () => `w/doc-${++docSeq}`

function connect(): MessagePort {
  const worker = new SharedWorker(new URL('./sse-shared-worker.ts', import.meta.url), {
    type: 'module',
  })
  worker.port.start()
  return worker.port
}

// The worker's module load, its connect dispatch and its first fetch are all
// async, and a fixed sleep long enough on an idle machine is not long enough
// under a full parallel suite. Wait on the observable instead.
const until = (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true))
const idle = () => vi.waitFor(() => expect(true).toBe(true))

describe('sse-shared-worker', () => {
  it('opens one stream however many documents are subscribed', async () => {
    // The whole reason this lives in a worker: six HTTP/1.1 connections per
    // origin is the budget, and a stream per canvas would spend it on sync.
    const port = connect()
    port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
    port.postMessage({ type: 'subscribe', doc: nextDoc() })
    port.postMessage({ type: 'subscribe', doc: nextDoc() })
    port.postMessage({ type: 'subscribe', doc: nextDoc() })
    await until(() => subscribeBodies.length >= 3)

    expect(streamOpens).toBe(1)
  })

  it('forwards only the subscribed document, not every frame on the stream', async () => {
    const port = connect()
    const seen: unknown[] = []
    port.onmessage = (e) => seen.push(e.data)
    const doc = nextDoc()
    port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
    port.postMessage({ type: 'subscribe', doc })
    await until(() => pushFrame !== null && subscribeBodies.length >= 1)

    pushFrame?.(
      `event: update\ndata: ${JSON.stringify({ doc: 'w/other', update: btoa('\x09') })}\n\n`,
    )
    pushFrame?.(`event: update\ndata: ${JSON.stringify({ doc, update: btoa('\x07') })}\n\n`)
    await until(() => seen.length >= 1)
    await idle()

    expect(seen).toEqual([{ type: 'update', doc, update: btoa('\x07') }])
  })

  it('takes a document back off the stream once it is unsubscribed', async () => {
    const port = connect()
    const doc = nextDoc()
    port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
    port.postMessage({ type: 'subscribe', doc })
    await until(() => subscribeBodies.length >= 1)
    expect(subscribeBodies.some((x) => x.includes('unsubscribe'))).toBe(false)

    port.postMessage({ type: 'unsubscribe', doc })

    await until(() => subscribeBodies.some((x) => x.includes(`"unsubscribe":["${doc}"]`)))
  })
})
