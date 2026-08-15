/**
 * The worker replica must know a document's PRE-EXISTING state, not only what
 * arrived while the worker happened to be alive.
 *
 * The SSE stream carries incremental updates from subscription onward — the
 * daemon's subscribe route registers routing and seeds nothing. A replica fed
 * only by the stream therefore holds a document's history since the worker
 * booted, and answers `snapshot-request` with a state that silently omits
 * everything older. A tab forking from that answer starts from partial truth,
 * which is worse than an error in exactly the way a wrong empty state is.
 *
 * Its own file because `@vitest/web-worker` runs every worker in the host
 * realm and loro-crdt's WASM initialises once per realm: the file gets ONE
 * replica-capable worker, shared across cases, separated by document key.
 */
import '@vitest/web-worker'
import { LoroDoc } from 'loro-crdt'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = 'http://127.0.0.1:3099'

let streamSeq = 0
const subscribeBodies: string[] = []
const pushByStream = new Map<string, (frame: string) => void>()
/** Pre-existing content per doc key, served by the daemon's snapshot route. */
const snapshotByDoc = new Map<string, Uint8Array>()
const snapshotHits: string[] = []

const server = setupServer(
  http.get(`${BASE}/api/sync/stream`, () => {
    streamSeq += 1
    const id = `seed-${streamSeq}`
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
    subscribeBodies.push(await request.text())
    return HttpResponse.json({ ok: true })
  }),
  http.get(`${BASE}/api/canvas/:workspaceId/:slug/update`, () => HttpResponse.json({ ok: true })),
  http.post(`${BASE}/api/canvas/:workspaceId/:slug/update`, () => HttpResponse.json({ ok: true })),
  http.get(`${BASE}/api/canvas/:workspaceId/:slug/snapshot`, ({ params }) => {
    const doc = `${String(params.workspaceId)}/${String(params.slug)}`
    snapshotHits.push(doc)
    const bytes = snapshotByDoc.get(doc)
    if (!bytes) return HttpResponse.json({ title: 'Canvas not found' }, { status: 404 })
    return new HttpResponse(bytes.slice().buffer as ArrayBuffer, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())

const decode = (encoded: string) => Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))

let docSeq = 0
const nextDoc = () => `seed-ws/doc-${++docSeq}`

let port: MessagePort
beforeAll(() => {
  const worker = new SharedWorker(new URL('./sse-shared-worker.ts', import.meta.url), {
    type: 'module',
  })
  port = worker.port
  port.start()
  port.postMessage({ type: 'init', baseUrl: BASE, token: 't' })
})

function requestSnapshot(doc: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; doc?: string; snapshot?: string }
      if (data.type !== 'snapshot' || data.doc !== doc || data.snapshot === undefined) return
      port.removeEventListener('message', onMessage)
      resolve(decode(data.snapshot))
    }
    port.addEventListener('message', onMessage)
    port.postMessage({ type: 'snapshot-request', doc })
    setTimeout(() => reject(new Error(`no snapshot for ${doc}`)), 12_000)
  })
}

describe('worker replica seeding', { timeout: 25_000 }, () => {
  it('answers a snapshot-request with state that predates the worker', async () => {
    const doc = nextDoc()
    const existing = new LoroDoc()
    existing.getMap('m').set('history', 'before-the-worker')
    existing.commit()
    snapshotByDoc.set(doc, existing.export({ mode: 'snapshot' }))

    port.postMessage({ type: 'subscribe', doc })
    const forked = new LoroDoc()
    forked.import(await requestSnapshot(doc))
    expect(forked.getMap('m').get('history')).toBe('before-the-worker')
  })

  it('answers empty for a document the daemon does not know, and only asks the daemon once', async () => {
    // A 404 is an answer, not a failure: forking from empty is the same path
    // a first-ever open takes. And it must be REMEMBERED — re-fetching the
    // snapshot on every request would turn each open into the daemon round
    // trip the replica exists to remove.
    const doc = nextDoc()
    port.postMessage({ type: 'subscribe', doc })
    const first = new LoroDoc()
    first.import(await requestSnapshot(doc))
    expect(first.getMap('m').size).toBe(0)

    await requestSnapshot(doc)
    expect(snapshotHits.filter((hit) => hit === doc).length).toBe(1)
  })
})
