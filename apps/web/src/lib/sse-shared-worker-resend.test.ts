// @vitest-environment node
/**
 * What happens to a tab's edit when the daemon refuses the write.
 *
 * Its own file, and that is not organisational tidiness. `@vitest/web-worker`
 * runs every worker in the host realm and loro-crdt's WASM initialises ONCE
 * per realm: the first worker to import it gets the module, every worker after
 * it is refused with `TypeError: Cannot read properties of undefined (reading
 * 'id')`, and the worker then degrades exactly as designed — relay up, replica
 * mute — so a second replica-dependent worker does not fail, it hangs. A file
 * is a fresh realm, so a file gets one replica-capable worker. Every case here
 * therefore shares ONE port and separates itself by document key, the way the
 * sibling worker suite already separates itself from leftover workers.
 */
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import '@vitest/web-worker'
import { LoroDoc } from 'loro-crdt'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const BASE = 'http://127.0.0.1:3099'

let streamSeq = 0
const subscribeBodies: string[] = []
const pushByStream = new Map<string, (frame: string) => void>()
const endByStream = new Map<string, () => void>()
const daemonWrites: { doc: string; body: Uint8Array }[] = []
/** Flipped per case to make the daemon refuse the write. */
let refuseWrites = false
/** Set per case to refuse every write for good, with this answer. */
let refuseFor: { status: number; body: { error: string; message: string } } | null = null
/** Set per case to fail this many snapshot fetches before answering. */
let failSnapshots = 0
/** Set per case to hold the next snapshot answer until released. */
let holdSnapshot: Promise<void> | null = null
/** Every write the daemon was sent, accepted or not, per document. */
const writeAttempts = new Map<string, number>()
/** Set per case to hold the next accepted write's answer until released. */
let holdNextWrite: Promise<void> | null = null

const server = setupServer(
  http.get(`${BASE}/api/sync/stream`, () => {
    streamSeq += 1
    const id = `resend-${streamSeq}`
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(
          enc.encode(`event: ready\ndata: ${JSON.stringify({ streamId: id })}\n\n`),
        )
        pushByStream.set(id, (f) => controller.enqueue(enc.encode(f)))
        endByStream.set(id, () => controller.close())
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
  // Answered rather than left to `bypass`: the worker seeds every subscribed
  // document from this route, and an unhandled request would escape to
  // whatever real daemon is on this port.
  http.get(`${BASE}/api/w/:workspaceId/document/:path/snapshot`, async () => {
    const hold = holdSnapshot
    holdSnapshot = null
    if (hold) await hold
    if (failSnapshots > 0) {
      failSnapshots -= 1
      return new HttpResponse('restarting', { status: 503 })
    }
    return HttpResponse.json({ title: 'Canvas not found' }, { status: 404 })
  }),
  http.post(`${BASE}/api/w/:workspaceId/document/:path/update`, async ({ request, params }) => {
    const attempted = `${String(params.workspaceId)}/${String(params.path)}`
    writeAttempts.set(attempted, (writeAttempts.get(attempted) ?? 0) + 1)
    // A refusal that ANSWERS rather than drops the connection: a 5xx is the
    // shape a restarting daemon actually produces, and it is the one a
    // `fetch().catch()` cannot see — fetch resolves, so a writer that only
    // catches rejections counts this as a success.
    if (refuseWrites) return new HttpResponse('nope', { status: 503 })
    if (refuseFor) return HttpResponse.json(refuseFor.body, { status: refuseFor.status })
    const hold = holdNextWrite
    holdNextWrite = null
    if (hold) await hold
    daemonWrites.push({
      doc: `${String(params.workspaceId)}/${String(params.path)}`,
      body: new Uint8Array(await request.arrayBuffer()),
    })
    return HttpResponse.json({ ok: true })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())

const until = (predicate: () => boolean) =>
  vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 25 })
/** A real window in which a wrong write could arrive, for asserting none does. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

let docSeq = 0
const nextDoc = () => `resend-ws/doc-${++docSeq}`

const subscribeIndexFor = (doc: string) =>
  subscribeBodies.findIndex((b) => b.includes(`"subscribe":["${doc}"]`))
const streamIdFor = (doc: string): string | undefined => {
  const i = subscribeIndexFor(doc)
  if (i === -1) return undefined
  return JSON.parse(subscribeBodies[i] as string).streamId as string
}

/** One worker for the whole file — see the header. */
let port: MessagePort

beforeAll(() => {
  const worker = new SharedWorker(new URL('./sse-shared-worker.ts', import.meta.url), {
    type: 'module',
  })
  port = worker.port
  port.start()
  port.onmessage = (e: MessageEvent) => events.push(e.data as (typeof events)[number])
  port.postMessage({ type: 'init', baseUrl: BASE })
})

/** What the worker told this port, in order. */
const events: {
  type: string
  doc?: string
  landed?: boolean
  refusal?: unknown
  snapshot?: string
}[] = []
const writeStatesFor = (doc: string, landed: boolean) =>
  events.filter((e) => e.doc === doc && e.type === 'write-state' && e.landed === landed).length

/** An edit from a tab, as one push. */
function pushEdit(doc: string, key: string, value: string): void {
  const tab = new LoroDoc()
  tab.getMap('m').set(key, value)
  tab.commit()
  port.postMessage({ type: 'push', doc, update: bytesToBase64(tab.export({ mode: 'update' })) })
}

describe('a write the daemon refused', { timeout: 25_000 }, () => {
  it('rides along with the next write instead of being lost', async () => {
    // The replica is what decides which bytes reach the daemon, so a delta it
    // has already merged is a delta it will never offer again — the tab's own
    // recovery (a full-state re-send on reconnect) is absorbed as a no-op
    // before it can help. Whatever the daemon has NOT acknowledged has to
    // stay on the replica's outbound side, or the edit is visible in every
    // tab and stored nowhere.
    const doc = nextDoc()
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    refuseWrites = true
    pushEdit(doc, 'refused', 'first-edit')
    await settle()
    expect(daemonWrites.filter((w) => w.doc === doc)).toEqual([])

    refuseWrites = false
    pushEdit(doc, 'accepted', 'second-edit')

    await until(() => daemonWrites.some((w) => w.doc === doc))
    const received = new LoroDoc()
    for (const write of daemonWrites.filter((w) => w.doc === doc)) received.import(write.body)
    expect(received.getMap('m').get('accepted')).toBe('second-edit')
    // The one that matters: the refused edit is in there too.
    expect(received.getMap('m').get('refused')).toBe('first-edit')
  })

  it('is flushed when the stream comes back, with no further edit to carry it', async () => {
    // A daemon restart is the common case, and the tab that made the edit may
    // never touch the canvas again. Nothing else would ever trigger a retry.
    const doc = nextDoc()
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    refuseWrites = true
    pushEdit(doc, 'stranded', 'only-edit')
    await settle()
    expect(daemonWrites.filter((w) => w.doc === doc)).toEqual([])

    refuseWrites = false
    // The stream really ends, which is what a restarting daemon does and what
    // the hub's reconnect — and therefore the worker's connection change —
    // actually keys on. Enqueuing a frame would not do it.
    endByStream.get(streamIdFor(doc) as string)?.()

    await until(() => daemonWrites.some((w) => w.doc === doc))
    const received = new LoroDoc()
    for (const write of daemonWrites.filter((w) => w.doc === doc)) received.import(write.body)
    expect(received.getMap('m').get('stranded')).toBe('only-edit')
  })

  it('is retried on its own, with no further edit and no reconnect to carry it', async () => {
    // The person stops typing and the stream stays up: neither trigger above
    // fires, and the edit would wait for as long as the tab stays open —
    // then vanish with the worker when the last one closes.
    const doc = nextDoc()
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    refuseWrites = true
    pushEdit(doc, 'quiet', 'last-edit')
    await settle()
    expect(daemonWrites.filter((w) => w.doc === doc)).toEqual([])

    refuseWrites = false
    await until(() => daemonWrites.some((w) => w.doc === doc))
    const received = new LoroDoc()
    for (const write of daemonWrites.filter((w) => w.doc === doc)) received.import(write.body)
    expect(received.getMap('m').get('quiet')).toBe('last-edit')
  })

  it('is told to the tab while it is outstanding, and its landing is told too', async () => {
    // The tab has no other way to know: its push went to the worker and
    // returned at once, so without this the editor reads saved over an edit
    // the keeper never took.
    const doc = nextDoc()
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    refuseWrites = true
    pushEdit(doc, 'told', 'edit')
    await until(() => writeStatesFor(doc, false) > 0)
    expect(writeStatesFor(doc, true)).toBe(0)

    refuseWrites = false
    await until(() => writeStatesFor(doc, true) > 0)
  })

  it('is told to a tab that subscribes while the write is still failing', async () => {
    // That tab was not there when the failure was announced; without this it
    // would read as saved over an edit still being retried.
    const doc = nextDoc()
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    refuseWrites = true
    pushEdit(doc, 'late', 'edit')
    await until(() => writeStatesFor(doc, false) === 1)

    port.postMessage({ type: 'unsubscribe', doc })
    port.postMessage({ type: 'subscribe', doc })
    await until(() => writeStatesFor(doc, false) === 2)
    refuseWrites = false
    await until(() => writeStatesFor(doc, true) > 0)
  })

  it('says it landed only once nothing newer is still outstanding', async () => {
    // A retry carries what the replica held when it started. An edit that
    // arrives while it is in flight is the NEXT write's, so the retry landing
    // is not the failure being over — here that next write is refused too,
    // and announcing a landing in between would read as saved over it.
    const doc = nextDoc()
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    refuseWrites = true
    pushEdit(doc, 'first', 'refused')
    await until(() => writeStatesFor(doc, false) === 1)

    let release: () => void = () => {}
    holdNextWrite = new Promise<void>((resolve) => {
      release = resolve
    })
    refuseWrites = false
    await until(() => holdNextWrite === null)
    // The retry is in flight and held; a newer edit reaches the replica, and
    // from here on the daemon refuses again.
    pushEdit(doc, 'second', 'while-in-flight')
    await settle()
    refuseWrites = true
    release()
    await until(() => daemonWrites.some((w) => w.doc === doc))
    await settle()
    expect(writeStatesFor(doc, true)).toBe(0)

    refuseWrites = false
    await until(() => writeStatesFor(doc, true) > 0)
    const received = new LoroDoc()
    for (const write of daemonWrites.filter((w) => w.doc === doc)) received.import(write.body)
    expect(received.getMap('m').get('second')).toBe('while-in-flight')
  })
})

describe('a write the daemon refused for what its bytes would do', { timeout: 25_000 }, () => {
  it('is dropped from the replica, and the tab is told why', async () => {
    // A 4xx answers the bytes, not the moment: sent again, they are refused
    // again, and every later write that carries them with it is refused too —
    // so nothing more from this browser would ever be saved.
    const doc = nextDoc()
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    refuseFor = {
      status: 413,
      body: { error: 'markdown_too_large', message: 'past the limit for one document' },
    }
    pushEdit(doc, 'refused', 'too-big')
    await until(() => events.some((e) => e.doc === doc && e.type === 'write-refused'))
    expect(events.find((e) => e.doc === doc && e.type === 'write-refused')?.refusal).toEqual({
      code: 'markdown_too_large',
      message: 'past the limit for one document',
    })
    refuseFor = null

    pushEdit(doc, 'later', 'kept')
    await until(() => daemonWrites.some((w) => w.doc === doc))
    const received = new LoroDoc()
    for (const write of daemonWrites.filter((w) => w.doc === doc)) received.import(write.body)
    expect(received.getMap('m').get('later')).toBe('kept')
    expect(received.getMap('m').get('refused')).toBeUndefined()

    // What a tab forks from after the refusal holds none of it either.
    port.postMessage({ type: 'snapshot-request', doc })
    await until(() => events.some((e) => e.doc === doc && e.type === 'snapshot'))
    const answered = events.filter((e) => e.doc === doc && e.type === 'snapshot').at(-1)
    const forked = new LoroDoc()
    forked.import(base64ToBytes(answered?.snapshot ?? '') ?? new Uint8Array())
    expect(forked.getMap('m').get('refused')).toBeUndefined()
  })

  it('is told only once the replica is the daemon state again', async () => {
    // A tab that forked while the snapshot could not be fetched would fork
    // the refused ops back, or an empty document; until the replica is
    // replaced, the tab hears only that the write did not land.
    const doc = nextDoc()
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    failSnapshots = 1
    refuseFor = { status: 400, body: { error: 'invalid_path', message: 'bad path' } }
    pushEdit(doc, 'refused', 'off-grammar')
    await until(() => writeStatesFor(doc, false) === 1)
    expect(events.some((e) => e.doc === doc && e.type === 'write-refused')).toBe(false)
    refuseFor = null

    await until(() => events.some((e) => e.doc === doc && e.type === 'write-refused'))
    expect(failSnapshots).toBe(0)
  })

  it('is not sent again by a reconnect while the replica is being replaced', async () => {
    const doc = nextDoc()
    port.postMessage({ type: 'subscribe', doc })
    await until(() => streamIdFor(doc) !== undefined)

    let release: () => void = () => {}
    holdSnapshot = new Promise<void>((resolve) => {
      release = resolve
    })
    refuseFor = { status: 413, body: { error: 'node_text_too_large', message: 'too long' } }
    pushEdit(doc, 'refused', 'long-text')
    await until(() => writeStatesFor(doc, false) === 1)
    const subscribesBefore = subscribeBodies.filter((b) => b.includes(doc)).length
    // A reconnect is a write trigger of its own, and it does not wait on the
    // replica: it would find the refused ops still outstanding.
    endByStream.get(streamIdFor(doc) as string)?.()
    await until(() => subscribeBodies.filter((b) => b.includes(doc)).length > subscribesBefore)
    refuseFor = null
    release()

    await until(() => events.some((e) => e.doc === doc && e.type === 'write-refused'))
    pushEdit(doc, 'later', 'kept')
    await until(() => daemonWrites.some((w) => w.doc === doc))
    expect(writeAttempts.get(doc)).toBe(2)
  })
})
