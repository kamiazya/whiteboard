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
import { LoroDoc } from 'loro-crdt'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const BASE = 'http://127.0.0.1:3099'

/**
 * Never reset between tests. Ids have to stay unique for the LIFETIME of the
 * file, not per test: leftover workers keep their streams open across the
 * reset, so a per-test counter hands a live stream's id to a new one and the
 * two collide in `pushByStream`.
 */
let streamSeq = 0
let subscribeBodies: string[] = []
let subscribeAuth: (string | null)[] = []
let messageBodies: string[] = []
/**
 * Keyed by stream id, NOT a single "most recent" handle. Workers from earlier
 * tests cannot be terminated and keep opening streams of their own, so a lone
 * `pushFrame` variable points at whichever stream opened last — frequently
 * somebody else's. A test then pushes its frame into a stream no port of its
 * own is listening to and waits for a message that will never arrive. That is
 * the load-dependent failure this file kept producing: under a full parallel
 * suite the leftover workers get more wall-clock to interleave.
 */
const pushByStream = new Map<string, (frame: string) => void>()

const server = setupServer(
  http.get(`${BASE}/api/sync/stream`, () => {
    streamSeq += 1
    // The daemon mints the id and announces it on the stream; a client cannot
    // choose one, which is what keeps it from naming another client's stream.
    const id = `server-${streamSeq}`
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(
          enc.encode(`event: ready\ndata: ${JSON.stringify({ streamId: id })}\n\n`),
        )
        pushByStream.set(id, (f) => controller.enqueue(enc.encode(f)))
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
  subscribeBodies = []
  subscribeAuth = []
  messageBodies = []
  pushByStream.clear()
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
//
// Importing the worker module statically to warm its graph — the trick that
// fixed App.test.tsx's lazy pages — is WRONG here and was tried: the module
// registers `onconnect` when it executes, so running it in the test realm
// breaks the per-worker isolation the polyfill provides, and the first test
// then hangs for the whole budget. A worker module is not context-free the way
// a React page is.
//
// The budget is explicit because `vi.waitFor` defaults to 1000ms, which is a
// fixed deadline wearing a poll's clothing: on a loaded machine the worker has
// not finished booting when it expires. Enlarging it is not the thing this
// file's header warns against — a poll returns the instant its condition
// holds, so an idle run pays nothing for the headroom, while a sleep would
// cost it every time.
const WAIT_MS = 15_000
const until = (predicate: () => boolean) =>
  vi.waitFor(() => expect(predicate()).toBe(true), { timeout: WAIT_MS, interval: 25 })

/** The index of the subscribe that first announced `doc`, or -1. */
const subscribeIndexFor = (doc: string) =>
  subscribeBodies.findIndex((b) => b.includes(`"subscribe":["${doc}"]`))

/** The Authorization header of the subscribe that first announced `doc`. */
const authFor = (doc: string): string | null | undefined => {
  const i = subscribeIndexFor(doc)
  return i === -1 ? undefined : subscribeAuth[i]
}

/**
 * The stream the worker announced `doc` on. Every assertion in this file goes
 * through a document the test itself minted, because that is the only handle
 * that cannot belong to a leftover worker — counting global stream opens or
 * reaching for "the first id" reads another test's traffic as this one's.
 */
const streamIdFor = (doc: string): string | undefined => {
  const i = subscribeIndexFor(doc)
  if (i === -1) return undefined
  return JSON.parse(subscribeBodies[i] as string).streamId as string
}

/** Pushes a frame into the stream that carries `doc`, never "the last one". */
const pushTo = (doc: string, frame: string) => {
  const id = streamIdFor(doc)
  if (id === undefined) throw new Error(`no stream announced ${doc} yet`)
  const push = pushByStream.get(id)
  if (push === undefined) throw new Error(`stream ${id} is not open`)
  push(frame)
}
/**
 * A real window in which a wrongly-forwarded message could arrive, for
 * asserting that none does. `vi.waitFor` cannot express this: it passes on its
 * first invocation, so it waits for approximately nothing.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

// Per-test budget above `until`'s, so a genuine hang still reports as the
// assertion that hung rather than as an opaque test timeout.
describe('sse-shared-worker', { timeout: WAIT_MS + 10_000 }, () => {
  it('opens one stream however many documents are subscribed', async () => {
    // The whole reason this lives in a worker: six HTTP/1.1 connections per
    // origin is the budget, and a stream per canvas would spend it on sync.
    const port = connect()
    const docs = [nextDoc(), nextDoc(), nextDoc()]
    port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
    for (const doc of docs) port.postMessage({ type: 'subscribe', doc })
    await until(() => docs.every((doc) => streamIdFor(doc) !== undefined))

    // One stream for the three, asserted as the three sharing an id rather
    // than as a global open count: the count also sees streams belonging to
    // workers this test did not create and cannot stop.
    expect(new Set(docs.map(streamIdFor)).size).toBe(1)
  })

  it('forwards only the subscribed document, not every frame on the stream', async () => {
    const port = connect()
    // Status events are liveness, not document frames; this case is about
    // which documents' frames are forwarded.
    const seen: unknown[] = []
    port.onmessage = (e) => {
      if ((e.data as { type?: string }).type !== 'status') seen.push(e.data)
    }
    const doc = nextDoc()
    port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    // The unsubscribed frame is pushed alone and given a real window to be
    // wrongly forwarded in. Sending both at once would prove nothing: they
    // would land in the same parser call, so the assertion would hold whether
    // or not the addressing worked.
    pushTo(
      doc,
      `event: update\ndata: ${JSON.stringify({ doc: 'w/other', update: btoa('\x09') })}\n\n`,
    )
    await settle()
    expect(seen).toEqual([])

    pushTo(doc, `event: update\ndata: ${JSON.stringify({ doc, update: btoa('\x07') })}\n\n`)
    await until(() => seen.length >= 1)

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
    await until(() => streamIdFor(doc) !== undefined)

    port.postMessage({ type: 'control', doc, message: { type: 'client_ready' } })

    await until(() => messageBodies.some((b) => b.includes(doc)))
    const body = JSON.parse(messageBodies.find((b) => b.includes(doc)) as string)
    expect(body.streamId).toBe(streamIdFor(doc))
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
    await until(() => subscribeIndexFor(doc) !== -1)

    port.postMessage({ type: 'init', baseUrl: BASE, token: 'new' })
    port.postMessage({ type: 'unsubscribe', doc })

    await until(() => subscribeBodies.some((x) => x.includes(`"unsubscribe":["${doc}"]`)))
  })

  // The hazard every assertion in this file is written around, made explicit
  // and deterministic. A SharedWorker cannot be terminated, so a worker from an
  // earlier test is still running and can open its stream at any moment —
  // including between this test's own connect and its assertion. Standing one
  // up on purpose is the only way to reproduce that ordering on demand;
  // waiting for it to happen by luck under load is what made these tests flake
  // in CI and pass in isolation.
  // The hazard every assertion in this file is written around, made explicit
  // and deterministic. A SharedWorker cannot be terminated, so a worker from an
  // earlier test is still running and can open a stream at any moment —
  // including AFTER this test has opened its own. Order matters: a leftover
  // worker opening first is harmless, because anything keyed on "the most
  // recent stream" still lands on ours. It is the LATER open that breaks it,
  // and that is the ordering a full parallel suite produces and an isolated
  // run does not, which is exactly why these tests passed alone and failed in
  // CI. Standing the neighbour up on purpose is the only way to reproduce it
  // on demand.
  it('keeps routing to its own stream when another worker opens one later', async () => {
    const port = connect()
    const doc = nextDoc()
    const seen: unknown[] = []
    port.onmessage = (e) => {
      if ((e.data as { type?: string }).type !== 'status') seen.push(e.data)
    }
    port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    // The leftover worker, opening its stream after ours.
    const neighbour = connect()
    const neighbourDoc = nextDoc()
    neighbour.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
    neighbour.postMessage({ type: 'subscribe', doc: neighbourDoc })
    await until(() => streamIdFor(neighbourDoc) !== undefined)
    expect(streamIdFor(doc)).not.toBe(streamIdFor(neighbourDoc))

    pushTo(doc, `event: update\ndata: ${JSON.stringify({ doc, update: btoa('\x07') })}\n\n`)
    await until(() => seen.length >= 1)
    expect(seen).toEqual([{ type: 'update', doc, update: btoa('\x07') }])
  })

  it('takes a document back off the stream once it is unsubscribed', async () => {
    const port = connect()
    const doc = nextDoc()
    port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
    port.postMessage({ type: 'subscribe', doc })
    await until(() => subscribeIndexFor(doc) !== -1)
    expect(subscribeBodies.some((x) => x.includes(`"unsubscribe":["${doc}"]`))).toBe(false)

    port.postMessage({ type: 'unsubscribe', doc })

    await until(() => subscribeBodies.some((x) => x.includes(`"unsubscribe":["${doc}"]`)))
  })
})

/**
 * The worker's replica of a document: the piece that makes tab, worker and
 * daemon one mechanism instead of three. A tab does not adopt this doc — it
 * forks, keeping its own peer and therefore its own undo stack, and exchanges
 * updates with it exactly the way the worker exchanges with the daemon.
 */
describe('authority replica', () => {
  // Single-port only, on purpose. The polyfill builds a fresh worker context
  // per `new SharedWorker` (see this file's header), so anything about two
  // ports meeting in one worker would pass or fail here for reasons that say
  // nothing about a browser. That half lives in the browser test beside it.
  const decode = (encoded: string) => Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
  const nextMessage = (port: MessagePort, type: string) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const onMessage = (e: MessageEvent) => {
        if ((e.data as { type?: string }).type !== type) return
        port.removeEventListener('message', onMessage)
        resolve(e.data as Record<string, unknown>)
      }
      port.addEventListener('message', onMessage)
      port.start()
    })

  it('answers a document nobody has opened with an empty snapshot, not an error', async () => {
    const port = connect()
    const doc = nextDoc()
    port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
    const reply = nextMessage(port, 'snapshot')
    port.postMessage({ type: 'snapshot-request', doc })

    // Forkable is the property that matters: forking from empty and letting
    // the daemon fill it in is the same path a first-ever open takes.
    const forked = new LoroDoc()
    forked.import(decode((await reply).snapshot as string))
    expect(forked.getMap('anything').size).toBe(0)
  })

  // A `push` followed by a snapshot-request is NOT tested here: under the
  // polyfill the port stops delivering anything at all after a push, while the
  // same sequence works in a real browser (see the browser test beside this).
  // Chasing that difference would be debugging the polyfill, not the worker.

  // NOT covered anywhere yet, and worth saying so: that a DAEMON frame lands
  // in the replica (not only in the relay). jsdom can feed a daemon frame,
  // through MSW, but cannot observe the replica — every snapshot-request that
  // follows replica work stops being answered under the polyfill. The browser
  // test can observe the replica but has no daemon to feed it. Both halves
  // exist only in an E2E against a real daemon, which is where this belongs.
})
