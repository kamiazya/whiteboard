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
  http.get(`${BASE}/api/w/:workspaceId/canvas/:path/snapshot`, () =>
    HttpResponse.json({ title: 'Canvas not found' }, { status: 404 }),
  ),
  http.post(`${BASE}/api/w/:workspaceId/canvas/:path/update`, async ({ request, params }) => {
    // A refusal that ANSWERS rather than drops the connection: a 5xx is the
    // shape a restarting daemon actually produces, and it is the one a
    // `fetch().catch()` cannot see — fetch resolves, so a writer that only
    // catches rejections counts this as a success.
    if (refuseWrites) return new HttpResponse('nope', { status: 503 })
    daemonWrites.push({
      doc: `${String(params.workspaceId)}/${String(params.path)}`,
      body: new Uint8Array(await request.arrayBuffer()),
    })
    return HttpResponse.json({ ok: true })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())

const b64 = (bytes: Uint8Array) => {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return btoa(out)
}

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
  port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
})

/** An edit from a tab, as one push. */
function pushEdit(doc: string, key: string, value: string): void {
  const tab = new LoroDoc()
  tab.getMap('m').set(key, value)
  tab.commit()
  port.postMessage({ type: 'push', doc, update: b64(tab.export({ mode: 'update' })) })
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
})
