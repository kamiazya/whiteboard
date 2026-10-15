// @vitest-environment node
/**
 * The worker holds a document's replica, writer and acknowledged version only
 * while something still needs them: a subscribed tab, or an edit the daemon
 * has not taken yet.
 *
 * Observed through the replica's answer to a snapshot request, which is the
 * one thing a released replica changes for a tab. The daemon here answers a
 * snapshot with 404 unless a case gave the document content, so a replica
 * built afresh answers empty (or with the daemon's current content) while a
 * kept one still carries what it merged.
 *
 * Its own file because loro-crdt's WASM initialises once per realm and
 * `@vitest/web-worker` runs every worker in the host realm, so a file gets one
 * replica-capable worker (see `sse-shared-worker-resend.test.ts`'s header).
 * Every case shares ONE port and separates itself by document key.
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
const daemonWrites: { doc: string; body: Uint8Array }[] = []
const writeAttempts = new Map<string, number>()
/** Flipped per case to make the daemon answer every write with a 503. */
let refuseWrites = false
/** Set per case to hold the next write's answer until released. */
let holdNextWrite: Promise<void> | null = null
/** Documents whose every write the daemon refuses for what it would do (413). */
const refusedDocs = new Set<string>()
/** What the daemon holds, per document; absent answers a snapshot with 404. */
const daemonContent = new Map<string, string>()
const snapshotFetches = new Map<string, number>()

function daemonSnapshot(value: string): Uint8Array {
  const daemon = new LoroDoc()
  daemon.getMap('m').set('daemon', value)
  daemon.commit()
  return daemon.export({ mode: 'snapshot' })
}

const server = setupServer(
  http.get(`${BASE}/api/sync/stream`, () => {
    streamSeq += 1
    const id = `release-${streamSeq}`
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
  http.get(`${BASE}/api/w/:workspaceId/document/:path/snapshot`, ({ params }) => {
    const doc = `${String(params.workspaceId)}/${String(params.path)}`
    snapshotFetches.set(doc, (snapshotFetches.get(doc) ?? 0) + 1)
    const content = daemonContent.get(doc)
    return content === undefined
      ? HttpResponse.json({ title: 'Canvas not found' }, { status: 404 })
      : new HttpResponse(daemonSnapshot(content), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
  }),
  http.post(`${BASE}/api/w/:workspaceId/document/:path/update`, async ({ request, params }) => {
    const doc = `${String(params.workspaceId)}/${String(params.path)}`
    writeAttempts.set(doc, (writeAttempts.get(doc) ?? 0) + 1)
    if (refuseWrites) return new HttpResponse('restarting', { status: 503 })
    const hold = holdNextWrite
    holdNextWrite = null
    if (hold) await hold
    if (refusedDocs.has(doc)) {
      return HttpResponse.json(
        { error: 'markdown_too_large', message: 'past the limit' },
        { status: 413 },
      )
    }
    daemonWrites.push({ doc, body: new Uint8Array(await request.arrayBuffer()) })
    return HttpResponse.json({ ok: true })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())

const until = (predicate: () => boolean) =>
  vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 25 })

let docSeq = 0
const nextDoc = () => `release-ws/doc-${++docSeq}`

const streamIdFor = (doc: string): string | undefined => {
  const body = subscribeBodies.find((b) => b.includes(`"subscribe":["${doc}"]`))
  return body === undefined ? undefined : (JSON.parse(body).streamId as string)
}

/** What the worker told this port, in order. */
const events: { type: string; doc?: string; snapshot?: string }[] = []

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

function loroUpdate(key: string, value: string): Uint8Array {
  const tab = new LoroDoc()
  tab.getMap('m').set(key, value)
  tab.commit()
  return tab.export({ mode: 'update' })
}

async function subscribe(doc: string): Promise<void> {
  port.postMessage({ type: 'subscribe', doc })
  await until(() => streamIdFor(doc) !== undefined)
}

function pushEdit(doc: string, key: string, value: string): void {
  port.postMessage({ type: 'push', doc, update: bytesToBase64(loroUpdate(key, value)) })
}

/** The worker replica's answer to one snapshot request, read as the value under `key`. */
async function replicaValue(doc: string, key: string): Promise<unknown> {
  const seen = events.filter((e) => e.type === 'snapshot' && e.doc === doc).length
  port.postMessage({ type: 'snapshot-request', doc })
  await until(() => events.filter((e) => e.type === 'snapshot' && e.doc === doc).length > seen)
  const answer = events.filter((e) => e.type === 'snapshot' && e.doc === doc).at(-1)
  const replica = new LoroDoc()
  const bytes = base64ToBytes(answer?.snapshot ?? '')
  if (bytes !== null && bytes.byteLength > 0) replica.import(bytes)
  return replica.getMap('m').get(key)
}

/** Asks until the replica answers without `key`: released, then built afresh. */
async function untilReleased(doc: string, key: string): Promise<void> {
  await vi.waitFor(async () => expect(await replicaValue(doc, key)).toBeUndefined(), {
    timeout: 15_000,
    interval: 25,
  })
}

describe('a document the last tab has left', { timeout: 25_000 }, () => {
  it('releases its replica once nothing is left unsaved', async () => {
    // State the daemon sent is state the daemon has, so a replica holding
    // only that is released at once — a re-subscribe pays a fresh seed
    // either way.
    const doc = nextDoc()
    await subscribe(doc)
    pushByStream.get(streamIdFor(doc) as string)?.(
      `event: update\ndata: ${JSON.stringify({ doc, update: bytesToBase64(loroUpdate('daemon', 'frame')) })}\n\n`,
    )
    await until(() => events.some((e) => e.type === 'authority-update' && e.doc === doc))

    port.postMessage({ type: 'unsubscribe', doc })

    expect(await replicaValue(doc, 'daemon')).toBeUndefined()
  })

  it('keeps an edit still in flight, and releases it once the write lands', async () => {
    const doc = nextDoc()
    await subscribe(doc)
    let releaseWrite = () => {}
    holdNextWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    pushEdit(doc, 'held', 'edit')
    await until(() => (writeAttempts.get(doc) ?? 0) > 0)

    port.postMessage({ type: 'unsubscribe', doc })
    expect(await replicaValue(doc, 'held')).toBe('edit')

    releaseWrite()
    await until(() => daemonWrites.some((w) => w.doc === doc))
    await untilReleased(doc, 'held')
  })

  it('keeps an edit whose write is failing, and releases it once a retry lands', async () => {
    // The unacknowledged ops live only in the replica: releasing it here
    // would drop an edit the tab already reads as handed over.
    const doc = nextDoc()
    await subscribe(doc)
    refuseWrites = true
    pushEdit(doc, 'failing', 'edit')
    await until(() => (writeAttempts.get(doc) ?? 0) > 0)

    port.postMessage({ type: 'unsubscribe', doc })
    expect(await replicaValue(doc, 'failing')).toBe('edit')

    refuseWrites = false
    await until(() => daemonWrites.some((w) => w.doc === doc))
    const received = new LoroDoc()
    for (const write of daemonWrites.filter((w) => w.doc === doc)) received.import(write.body)
    expect(received.getMap('m').get('failing')).toBe('edit')
    await untilReleased(doc, 'failing')
  })

  it('releases a replica rebuilt after a refused write, so a reopen sees the daemon afresh', async () => {
    // The rebuild drops the refused edit with the replica that held it. Were
    // the edit still counted as unsaved, the document could never be
    // released, and its next opener would be served the rebuild's content
    // for the worker's whole lifetime.
    const doc = nextDoc()
    daemonContent.set(doc, 'before')
    refusedDocs.add(doc)
    await subscribe(doc)
    let releaseWrite = () => {}
    holdNextWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    pushEdit(doc, 'refused', 'edit')
    await until(() => (writeAttempts.get(doc) ?? 0) > 0)

    port.postMessage({ type: 'unsubscribe', doc })
    // Released only once the worker has let the document go, so the rebuild
    // is the last thing that touches it rather than racing the unsubscribe.
    await until(() => subscribeBodies.some((b) => b.includes(`"unsubscribe":["${doc}"]`)))
    const fetchesBeforeRebuild = snapshotFetches.get(doc) ?? 0
    releaseWrite()
    // The rebuild's fetch arriving puts the rebuild on the replica queue. The
    // queue is one FIFO for every document, so a request for ANOTHER document
    // answered twice over is behind the rebuild and then behind the release
    // decision the rebuild queues. A request for THIS document would be a
    // tab reopening it early, seeding a replica of its own.
    await until(() => (snapshotFetches.get(doc) ?? 0) > fetchesBeforeRebuild)
    const barrier = nextDoc()
    await replicaValue(barrier, 'daemon')
    await replicaValue(barrier, 'daemon')
    // Content changed after the rebuild is content only a released replica,
    // seeded afresh, can see.
    daemonContent.set(doc, 'after')

    expect(await replicaValue(doc, 'daemon')).toBe('after')
  })
})
