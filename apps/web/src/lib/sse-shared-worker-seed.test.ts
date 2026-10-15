// @vitest-environment node
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
/** Ends a stream as a dropped connection does, so the worker reconnects and routes again. */
const dropByStream = new Map<string, () => void>()
/** Pre-existing content per doc key, served by the daemon's snapshot route. */
const snapshotByDoc = new Map<string, Uint8Array>()
const snapshotHits: string[] = []
/** Docs whose snapshot fetch answers 503 while listed — the outage case. */
const failingSnapshots = new Set<string>()
const updateWrites: { doc: string; body: Uint8Array }[] = []
/** Every read of a per-document snapshot, which nothing in the worker has a use for. */
const perDocumentSnapshotHits: string[] = []
/** Docs whose update write answers 503 while listed — a daemon briefly unable to take writes. */
const failingWrites = new Set<string>()

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
        dropByStream.set(id, () => controller.error(new Error('dropped')))
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
  http.get(`${BASE}/api/w/:workspaceId/workspace-document/update`, () =>
    HttpResponse.json({ ok: true }),
  ),
  http.post(`${BASE}/api/w/:workspaceId/workspace-document/update`, async ({ request, params }) => {
    if (failingWrites.has(`workspace:${String(params.workspaceId)}`))
      return HttpResponse.json({ title: 'busy' }, { status: 503 })
    updateWrites.push({
      doc: `workspace:${String(params.workspaceId)}`,
      body: new Uint8Array(await request.arrayBuffer()),
    })
    return HttpResponse.json({ ok: true })
  }),
  http.get(`${BASE}/api/w/:workspaceId/workspace-document/snapshot`, ({ params }) => {
    const doc = `workspace:${String(params.workspaceId)}`
    snapshotHits.push(doc)
    if (failingSnapshots.has(doc)) return HttpResponse.json({ title: 'boom' }, { status: 503 })
    const bytes = snapshotByDoc.get(doc)
    if (!bytes) return HttpResponse.json({ title: 'Canvas not found' }, { status: 404 })
    return new HttpResponse(bytes.slice().buffer as ArrayBuffer, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  }),
  http.get(`${BASE}/api/w/:workspaceId/document/:path/snapshot`, ({ params }) => {
    perDocumentSnapshotHits.push(`${String(params.workspaceId)}/${String(params.path)}`)
    return HttpResponse.json({ title: 'not this route' }, { status: 500 })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())

const decode = (encoded: string) => base64ToBytes(encoded) as Uint8Array

let docSeq = 0
const nextDoc = () => `workspace:seed-ws-doc-${++docSeq}`

let port: MessagePort
/** Every write-state the worker told this port, in order. */
const writeStates: { doc: string; landed: boolean }[] = []
/** Documents the worker has told this port are routed. */
const routedDocs = new Set<string>()
beforeAll(() => {
  const worker = new SharedWorker(new URL('./sse-shared-worker.ts', import.meta.url), {
    type: 'module',
  })
  port = worker.port
  port.start()
  port.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: string; doc?: string; landed?: boolean }
    if (data.type === 'write-state' && data.doc !== undefined && data.landed !== undefined)
      writeStates.push({ doc: data.doc, landed: data.landed })
    const status = e.data as { type?: string; doc?: string; connected?: boolean }
    if (status.type === 'status' && status.doc !== undefined) {
      if (status.connected) routedDocs.add(status.doc)
      else routedDocs.delete(status.doc)
    }
  })
  port.postMessage({ type: 'init', baseUrl: BASE })
})

const until = (predicate: () => boolean) =>
  vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 25 })

/**
 * Subscribe, and wait until the worker says the stream carries the document:
 * a tab reads its state only then, so a case asking sooner would be asking
 * in an order no tab does.
 */
async function subscribed(doc: string): Promise<void> {
  port.postMessage({ type: 'subscribe', doc })
  await until(() => routedDocs.has(doc))
}

function unsubscribe(doc: string): void {
  routedDocs.delete(doc)
  port.postMessage({ type: 'unsubscribe', doc })
}

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

    await subscribed(doc)
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
    await subscribed(doc)
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

    await subscribed(doc)
    const first = new LoroDoc()
    first.import(await requestSnapshot(doc))
    expect(first.getMap('m').get('phase')).toBe('before-gap')

    unsubscribe(doc)
    // The daemon-side write that happens while nobody is subscribed.
    const after = before.fork()
    after.getMap('m').set('written-in-gap', 'yes')
    after.commit()
    snapshotByDoc.set(doc, after.export({ mode: 'snapshot' }))

    await subscribed(doc)
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

    await subscribed(doc)
    await requestSnapshot(doc)

    // An independent peer's edit: its ops carry no deps on the seed, so a
    // clean delta imports readably into a fresh doc below — while a
    // regressed baseline would drag the seeded ops along with it.
    const tab = new LoroDoc()
    tab.getMap('m').set('edit', 'after-seed')
    tab.commit()
    port.postMessage({ type: 'push', doc, update: bytesToBase64(tab.export({ mode: 'update' })) })

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

  it('subscribing a per-document key makes no snapshot request', async () => {
    // A per-document subscription carries text alone — binary frames travel
    // on the workspace key — so a replica of it would cost a snapshot read
    // at open and at every reconnect, and a resident CRDT nobody reads.
    const doc = 'seed-ws/plan'
    await subscribed(doc)
    // Any seed the subscribe queued runs ahead of this answer on the replica
    // queue, so by the time it arrives its read has been made or never will.
    await requestSnapshot(nextDoc())

    expect(perDocumentSnapshotHits).toEqual([])
    unsubscribe(doc)
  })

  it('retries the seed after a transport failure instead of remembering it', async () => {
    // A 404 is an answer; a 503 or a dropped connection is not. Remembering
    // a failed fetch as "seeded" would hand every later tab an empty
    // document that the daemon actually has content for. While the outage
    // lasts the answer is no bytes at all (each request retries and fails
    // again) — never an empty document, which a tab would take as the
    // keeper's; the first request after recovery gets the real state.
    const doc = nextDoc()
    const content = new LoroDoc()
    content.getMap('m').set('survives', 'the-outage')
    content.commit()
    snapshotByDoc.set(doc, content.export({ mode: 'snapshot' }))
    failingSnapshots.add(doc)

    await subscribed(doc)
    expect(await requestSnapshot(doc)).toHaveLength(0)

    failingSnapshots.delete(doc)
    const after = new LoroDoc()
    after.import(await requestSnapshot(doc))
    expect(after.getMap('m').get('survives')).toBe('the-outage')
  })

  it('still writes an edit that was outstanding when a late seed landed', async () => {
    // The seed may acknowledge only what it imported, never what the replica
    // already held: an edit a tab pushed while the daemon could take neither
    // the seed nor the write is in the replica BEFORE the seed lands, and
    // moving the acknowledged baseline past it would make the retry find
    // nothing outstanding — the edit stored nowhere, and reported landed.
    const doc = nextDoc()
    const content = new LoroDoc()
    content.getMap('m').set('seeded', 'yes')
    content.commit()
    snapshotByDoc.set(doc, content.export({ mode: 'snapshot' }))
    failingSnapshots.add(doc)
    failingWrites.add(doc)

    await subscribed(doc)
    await requestSnapshot(doc)
    const tab = new LoroDoc()
    tab.getMap('m').set('edit', 'before-seed')
    tab.commit()
    port.postMessage({ type: 'push', doc, update: bytesToBase64(tab.export({ mode: 'update' })) })
    await until(() => writeStates.some((s) => s.doc === doc && !s.landed))

    failingSnapshots.delete(doc)
    const seeded = new LoroDoc()
    seeded.import(await requestSnapshot(doc))
    expect(seeded.getMap('m').get('seeded')).toBe('yes')
    // And the edit the replica already held: a later tab forks from both.
    expect(seeded.getMap('m').get('edit')).toBe('before-seed')

    failingWrites.delete(doc)
    await until(() => writeStates.some((s) => s.doc === doc && s.landed))
    const written = new LoroDoc()
    for (const write of updateWrites.filter((w) => w.doc === doc)) written.import(write.body)
    expect(written.getMap('m').get('edit')).toBe('before-seed')
  })
  it('catches up a replica a snapshot request seeded before its feed was routed', async () => {
    // A tab whose stream has not routed the document reads its state anyway,
    // which seeds the replica early. A write the daemon takes between that
    // seed and the routing reaches no frame, so the routing catches up
    // rather than counting the replica as seeded.
    const doc = nextDoc()
    const daemon = new LoroDoc()
    daemon.getMap('m').set('a', 'seeded-early')
    daemon.commit()
    snapshotByDoc.set(doc, daemon.export({ mode: 'snapshot' }))
    const early = new LoroDoc()
    early.import(await requestSnapshot(doc))
    expect(early.getMap('m').get('a')).toBe('seeded-early')

    daemon.getMap('m').set('b', 'in-the-gap')
    daemon.commit()
    snapshotByDoc.set(doc, daemon.export({ mode: 'snapshot' }))
    await subscribed(doc)
    await until(() => snapshotHits.filter((hit) => hit === doc).length >= 2)

    const later = new LoroDoc()
    later.import(await requestSnapshot(doc))
    expect(later.getMap('m').get('b')).toBe('in-the-gap')
  })

  it('counts a catch-up after a failed seed as the seed, so the next request reads nothing again', async () => {
    // The seed failed while the stream first routed the document; the routing
    // after a reconnect catches the replica up with the daemon's state. That
    // IS the seed, so a tab asking next is answered from the replica rather
    // than by one more read of the daemon.
    const doc = nextDoc()
    const content = new LoroDoc()
    content.getMap('m').set('a', 'after-the-outage')
    content.commit()
    snapshotByDoc.set(doc, content.export({ mode: 'snapshot' }))
    failingSnapshots.add(doc)
    await subscribed(doc)
    await until(() => snapshotHits.includes(doc))

    failingSnapshots.delete(doc)
    const hitsBefore = snapshotHits.filter((hit) => hit === doc).length
    for (const drop of dropByStream.values()) drop()
    dropByStream.clear()
    await until(() => snapshotHits.filter((hit) => hit === doc).length > hitsBefore)
    await until(() => routedDocs.has(doc))
    const caughtUp = snapshotHits.filter((hit) => hit === doc).length

    const answer = new LoroDoc()
    answer.import(await requestSnapshot(doc))
    expect(answer.getMap('m').get('a')).toBe('after-the-outage')
    expect(snapshotHits.filter((hit) => hit === doc)).toHaveLength(caughtUp)
  })
})
