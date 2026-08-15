/**
 * The SharedWorker half of the SseStreamSource contract — the implementation
 * the app actually ships, driven through its real construction path with MSW
 * standing in for the daemon.
 *
 * The contract itself lives with the port in mcp-server. Running the same cases
 * on both sides is the point: a defect reached a merged branch because every
 * test drove the hub, and the gap was invisible from inside that suite.
 */
import '@vitest/web-worker'
import type { SseStreamSourceHarness } from '@kamiazya/whiteboard-mcp/sse-stream-source-contract'
import { sseStreamSourceContract } from '@kamiazya/whiteboard-mcp/sse-stream-source-contract'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, vi } from 'vitest'
import { createSharedSseStreamSource } from './sse-shared-stream-source.js'

const BASE = 'http://127.0.0.1:3099'

// Deliberately never reset between cases. The whole point of this
// implementation is that one stream per origin outlives any single consumer,
// so clearing these would close nothing and simply hide the live stream from
// every case after the first. The contract's per-case document keys are what
// separate one case's traffic from another's.
let streamOpens = 0
const openedStreamIds: string[] = []
const daemonWrites: { doc: string; body: Uint8Array }[] = []
const subscribeBodies: { subscribe?: string[]; unsubscribe?: string[] }[] = []
const controlMessages: { streamId: string; doc: string; message: unknown }[] = []
let pushFrame: ((frame: string) => void) | null = null
let endStream: (() => void) | null = null

const server = setupServer(
  http.get(`${BASE}/api/sync/stream`, () => {
    streamOpens += 1
    const id = `worker-stream-${streamOpens}`
    openedStreamIds.push(id)
    return new HttpResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(
            enc.encode(`event: ready\ndata: ${JSON.stringify({ streamId: id })}\n\n`),
          )
          pushFrame = (f) => controller.enqueue(enc.encode(f))
          endStream = () => controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }),
  http.post(`${BASE}/api/sync/subscribe`, async ({ request }) => {
    subscribeBodies.push((await request.json()) as (typeof subscribeBodies)[number])
    return HttpResponse.json({ ok: true })
  }),
  // The canvas update route: where a push lands, after the worker's replica
  // has merged it. Addressed by workspace and slug, which the worker
  // reconstructs from the document key it routes everything else by.
  http.post(`${BASE}/api/canvas/:workspaceId/:slug/update`, async ({ request, params }) => {
    daemonWrites.push({
      doc: `${String(params.workspaceId)}/${String(params.slug)}`,
      body: new Uint8Array(await request.arrayBuffer()),
    })
    return HttpResponse.json({ ok: true })
  }),
  http.post(`${BASE}/api/sync/message`, async ({ request }) => {
    controlMessages.push((await request.json()) as (typeof controlMessages)[number])
    return HttpResponse.json({ ok: true })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function createHarness(): SseStreamSourceHarness {
  const source = createSharedSseStreamSource(BASE, 'contract-token')
  if (!source) throw new Error('SharedWorker unavailable')

  return {
    source,
    pushUpdate: (doc, bytes) => {
      pushFrame?.(`event: update\ndata: ${JSON.stringify({ doc, update: toBase64(bytes) })}\n\n`)
    },
    pushText: (doc, raw) => {
      pushFrame?.(`event: message\ndata: ${JSON.stringify({ doc, raw })}\n\n`)
    },
    subscribedDocs: () => subscribeBodies.flatMap((b) => b.subscribe ?? []),
    unsubscribedDocs: () => subscribeBodies.flatMap((b) => b.unsubscribe ?? []),
    controlMessages: () => controlMessages,
    openedStreamIds: () => openedStreamIds,
    daemonWrites: () => daemonWrites,
    ready: async () => {
      await vi.waitFor(() => {
        if (pushFrame === null) throw new Error('stream not open')
      })
    },
    // A SharedWorker cannot be terminated and this source is cached per origin,
    // so teardown is a no-op; the contract's per-case document keys are what
    // keep one case's traffic from being read as another's.
    dropStream: () => endStream?.(),
    cleanup: () => {},
  }
}

describe('SseStreamSource contract: SharedWorker-backed source', () => {
  sseStreamSourceContract(createHarness)
})
