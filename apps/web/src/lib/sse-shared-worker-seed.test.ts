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
/** Docs whose snapshot fetch answers 503 while listed — the outage case. */
const failingSnapshots = new Set<string>()
const updateWrites: { doc: string; body: Uint8Array }[] = []

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
  http.post(`${BASE}/api/canvas/:workspaceId/:slug/update`, async ({ request, params }) => {
    updateWrites.push({
      doc: `${String(params.workspaceId)}/${String(params.slug)}`,
      body: new Uint8Array(await request.arrayBuffer()),
    })
    return HttpResponse.json({ ok: true })
  }),
  http.get(`${BASE}/api/canvas/:workspaceId/:slug/snapshot`, ({ params }) => {
    const doc = `${String(params.workspaceId)}/${String(params.slug)}`
    snapshotHits.push(doc)
    if (failingSnapshots.has(doc)) return HttpResponse.json({ title: 'boom' }, { status: 503 })
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

  it('re-seeds a document that was fully released, so a daemon-side change in the gap is not lost', async () => {
    // While no tab holds a document the daemon deregisters its routing, so a
    // write landing in that gap (an MCP tool, another device) never reaches
    // this worker's stream. If the seed were remembered for the worker's
    // LIFETIME, reopening the document would serve the pre-gap state forever
    // — so a full release must also forget the seed, and the next subscriber
    // pays one fresh snapshot fetch, exactly like a first open.
    const doc = nextDoc()
    const before = new LoroDoc()
    before.getMap('m').set('phase', 'before-gap')
    before.commit()
    snapshotByDoc.set(doc, before.export({ mode: 'snapshot' }))

    port.postMessage({ type: 'subscribe', doc })
    const first = new LoroDoc()
    first.import(await requestSnapshot(doc))
    expect(first.getMap('m').get('phase')).toBe('before-gap')

    port.postMessage({ type: 'unsubscribe', doc })
    // The daemon-side write that happens while nobody is subscribed.
    const after = before.fork()
    after.getMap('m').set('written-in-gap', 'yes')
    after.commit()
    snapshotByDoc.set(doc, after.export({ mode: 'snapshot' }))

    port.postMessage({ type: 'subscribe', doc })
    const reopened = new LoroDoc()
    reopened.import(await requestSnapshot(doc))
    expect(reopened.getMap('m').get('written-in-gap')).toBe('yes')
    expect(snapshotHits.filter((hit) => hit === doc).length).toBe(2)
  })

  it('acknowledges the seeded state, so the first push after a seed travels as a delta', async () => {
    // The daemon HAS the seed by definition. If the seed did not advance the
    // acknowledged baseline, the first tab push would re-send the entire
    // seeded document — bandwidth Loro merges away, but paid on every open
    // of every document, which is the cost the replica exists to remove.
    const doc = nextDoc()
    const seeded = new LoroDoc()
    seeded.getMap('m').set('phase', 'seeded-history')
    seeded.commit()
    snapshotByDoc.set(doc, seeded.export({ mode: 'snapshot' }))

    port.postMessage({ type: 'subscribe', doc })
    await requestSnapshot(doc)

    // An independent peer's edit: its ops carry no deps on the seed, so a
    // clean delta imports readably into a fresh doc below — while a
    // regressed baseline would drag the seeded ops along with it.
    const tab = new LoroDoc()
    tab.getMap('m').set('edit', 'after-seed')
    tab.commit()
    const b64 = (bytes: Uint8Array) => {
      let out = ''
      for (const byte of bytes) out += String.fromCharCode(byte)
      return btoa(out)
    }
    port.postMessage({ type: 'push', doc, update: b64(tab.export({ mode: 'update' })) })

    await new Promise<void>((resolve, reject) => {
      const t = setInterval(() => {
        if (updateWrites.some((w) => w.doc === doc)) {
          clearInterval(t)
          resolve()
        }
      }, 25)
      setTimeout(() => reject(new Error('no daemon write')), 12_000)
    })
    const write = updateWrites.find((w) => w.doc === doc)
    const delta = new LoroDoc()
    delta.import(write?.body as Uint8Array)
    expect(delta.getMap('m').get('edit')).toBe('after-seed')
    expect(delta.getMap('m').get('phase')).toBeUndefined()
  })

  it('retries the seed after a transport failure instead of remembering it', async () => {
    // A 404 is an answer; a 503 or a dropped connection is not. Remembering
    // a failed fetch as "seeded" would hand every later tab an empty
    // document that the daemon actually has content for. While the outage
    // lasts the answer is empty (each request retries and fails again); the
    // first request after recovery gets the real state.
    const doc = nextDoc()
    const content = new LoroDoc()
    content.getMap('m').set('survives', 'the-outage')
    content.commit()
    snapshotByDoc.set(doc, content.export({ mode: 'snapshot' }))
    failingSnapshots.add(doc)

    port.postMessage({ type: 'subscribe', doc })
    const during = new LoroDoc()
    during.import(await requestSnapshot(doc))
    expect(during.getMap('m').get('survives')).toBeUndefined()

    failingSnapshots.delete(doc)
    const after = new LoroDoc()
    after.import(await requestSnapshot(doc))
    expect(after.getMap('m').get('survives')).toBe('the-outage')
  })
})
