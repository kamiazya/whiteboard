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
let subscribeAuth: (string | null)[] = []
let messageBodies: string[] = []
let openedStreamIds: string[] = []
let pushFrame: ((frame: string) => void) | null = null

const server = setupServer(
  http.get(`${BASE}/api/sync/stream`, ({ request }) => {
    streamOpens += 1
    const id = new URL(request.url).searchParams.get('streamId')
    if (id) openedStreamIds.push(id)
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
    subscribeAuth.push(request.headers.get('Authorization'))
    subscribeBodies.push(await request.text())
    return HttpResponse.json({ ok: true })
  }),
  http.post(`${BASE}/api/sync/message`, async ({ request }) => {
    messageBodies.push(await request.text())
    return HttpResponse.json({ ok: true })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())
beforeEach(() => {
  streamOpens = 0
  subscribeBodies = []
  subscribeAuth = []
  messageBodies = []
  openedStreamIds = []
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

/** The Authorization header of the subscribe that first announced `doc`. */
const authFor = (doc: string): string | null | undefined => {
  const i = subscribeBodies.findIndex((b) => b.includes(`"subscribe":["${doc}"]`))
  return i === -1 ? undefined : subscribeAuth[i]
}
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

  it('sends a control message under the stream id the worker actually opened', async () => {
    // The daemon addresses a control message by stream. A tab sending its own
    // id would name a stream the daemon has never seen, so client_ready would
    // be dropped and viewport requests would never arrive.
    const port = connect()
    const doc = nextDoc()
    port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
    port.postMessage({ type: 'subscribe', doc })
    await until(() => openedStreamIds.length >= 1)

    port.postMessage({ type: 'control', doc, message: { type: 'client_ready' } })

    await until(() => messageBodies.some((b) => b.includes(doc)))
    const body = JSON.parse(messageBodies.find((b) => b.includes(doc)) as string)
    expect(body.streamId).toBe(openedStreamIds[0])
    expect(body.message).toEqual({ type: 'client_ready' })
  })

  it('follows a rotated token instead of holding the one it started with', async () => {
    // A pairing session token is refreshed while tabs stay open. The hub is
    // cached per origin, so a credential captured when it was built would leave
    // every tab in the profile talking to the daemon with a dead token.
    const port = connect()
    const first = nextDoc()
    port.postMessage({ type: 'init', baseUrl: BASE, token: 'old' })
    port.postMessage({ type: 'subscribe', doc: first })
    // Matched by document rather than by count: opening the stream re-announces
    // the subscriptions, so a count would be satisfied by that echo instead.
    await until(() => authFor(first) !== undefined)
    expect(authFor(first)).toBe('Bearer old')

    port.postMessage({ type: 'init', baseUrl: BASE, token: 'new' })
    const second = nextDoc()
    port.postMessage({ type: 'subscribe', doc: second })

    await until(() => authFor(second) !== undefined)
    expect(authFor(second)).toBe('Bearer new')
  })

  it('keeps a port’s subscriptions across a re-init', async () => {
    // Re-init is how a rotated token arrives, not a fresh connection — losing
    // the port's subscription handles there would strand them: nothing could
    // release them and the worker would keep routing documents nobody watches.
    const port = connect()
    const doc = nextDoc()
    port.postMessage({ type: 'init', baseUrl: BASE, token: 'old' })
    port.postMessage({ type: 'subscribe', doc })
    await until(() => subscribeBodies.length >= 1)

    port.postMessage({ type: 'init', baseUrl: BASE, token: 'new' })
    port.postMessage({ type: 'unsubscribe', doc })

    await until(() => subscribeBodies.some((x) => x.includes(`"unsubscribe":["${doc}"]`)))
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
