// @vitest-environment node
/**
 * SseBackend over the SharedWorker-backed source, against the shared
 * DocumentBackend contract — the configuration server mode and every
 * non-bridge daemon actually run. The owned-hub configuration runs the same
 * cases in daemon-client.
 *
 * One worker for the whole file, separated per case by workspace: loro-crdt's
 * WASM initialises once per realm and `@vitest/web-worker` runs every worker
 * in the host realm, so a file gets one replica-capable worker (see
 * `sse-shared-worker-resend.test.ts`'s header), and the source is cached per
 * origin anyway.
 *
 * No `refuseAuth`: a refused credential ends the worker's stream for the
 * origin for the worker's life, which would end it for every later case
 * here. The worker's refusal path is the SseStreamSource contract's
 * (`sse-shared-stream-source.contract.test.ts`). No `sentUpdates` either: the
 * worker merges a push into its replica before writing onward, so arbitrary
 * bytes never reach the daemon — `localEdit` is a real Loro edit instead.
 */
import { SseBackend } from '@kamiazya/whiteboard-daemon-client/sse-backend'
import type { DocumentBackendHarness } from '@kamiazya/whiteboard-daemon-client/test-utils/document-backend-contract'
import { documentBackendContract } from '@kamiazya/whiteboard-daemon-client/test-utils/document-backend-contract'
import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import '@vitest/web-worker'
import { LoroDoc } from 'loro-crdt'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, vi } from 'vitest'
import { createSharedSseStreamSource } from './sse-shared-stream-source.js'

const BASE = 'http://127.0.0.1:3099'

/** Each case's daemon-side document, by workspace id. */
const keepers = new Map<string, LoroDoc>()
let pushFrame: ((frame: string) => void) | null = null
let endStream: (() => void) | null = null

const sseFrame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const server = setupServer(
  http.get(`${BASE}/api/sync/stream`, () => {
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(sseFrame('ready', { streamId: 'worker-contract' })))
        pushFrame = (frame) => controller.enqueue(enc.encode(frame))
        endStream = () => {
          pushFrame = null
          controller.close()
        }
      },
    })
    return new HttpResponse(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }),
  http.post(`${BASE}/api/sync/subscribe`, () => HttpResponse.json({ ok: true })),
  http.post(`${BASE}/api/sync/message`, () => HttpResponse.json({ ok: true })),
  http.get(`${BASE}/api/w/:workspaceId/workspace-document/snapshot`, ({ params }) => {
    const keeper = keepers.get(String(params.workspaceId))
    if (!keeper) return HttpResponse.json({ title: 'not found' }, { status: 404 })
    return new HttpResponse(keeper.export({ mode: 'snapshot' }).slice().buffer as ArrayBuffer, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  }),
  http.post(`${BASE}/api/w/:workspaceId/workspace-document/update`, async ({ request, params }) => {
    keepers.get(String(params.workspaceId))?.import(new Uint8Array(await request.arrayBuffer()))
    return HttpResponse.json({ ok: true })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterAll(() => server.close())

// The contract allows each connect a short settle, which a cold worker still
// loading loro's WASM does not meet. Its replica answering, and a stream open
// for it, are the warm worker every later case meets anyway.
beforeAll(async () => {
  const source = createSharedSseStreamSource(BASE)
  if (!source) throw new Error('SharedWorker unavailable')
  const off = source.subscribe('workspace:worker-contract-warmup', {
    onUpdate: () => {},
    onMessage: () => {},
  })
  await source.snapshot('workspace:worker-contract-warmup')
  await vi.waitFor(() => expect(pushFrame).not.toBeNull(), { timeout: 15_000 })
  off()
}, 20_000)

/** Whether `delivered`, applied in order to an empty document, reads as the keeper's. */
function reproduces(delivered: readonly Uint8Array[], keeper: LoroDoc): boolean {
  const replica = new LoroDoc()
  for (const bytes of delivered) {
    try {
      replica.import(bytes)
    } catch {
      // Bytes that are not Loro's say nothing about what was caught up.
    }
  }
  return replica.getText('t').toString() === keeper.getText('t').toString()
}

/** The keeper's own writes, broadcast on the open stream when `live`. */
function keeperWriter(workspaceId: string, keeper: LoroDoc): (live: boolean) => void {
  let broadcast = keeper.oplogVersion()
  let seq = 0
  return (live) => {
    const text = keeper.getText('t')
    text.insert(text.length, `+${++seq}`)
    keeper.commit()
    const update = keeper.export({ mode: 'update', from: broadcast })
    broadcast = keeper.oplogVersion()
    if (!live) return
    const frame = { doc: `workspace:${workspaceId}`, update: bytesToBase64(update) }
    pushFrame?.(sseFrame('update', frame))
  }
}

let caseSeq = 0

async function harness(): Promise<DocumentBackendHarness> {
  const source = createSharedSseStreamSource(BASE)
  if (!source) throw new Error('SharedWorker unavailable')
  const workspaceId = `worker-contract-${++caseSeq}`
  const keeper = new LoroDoc()
  keeper.getText('t').insert(0, 'seed')
  keeper.commit()
  keepers.set(workspaceId, keeper)
  // Seeded before the case connects, the way a second tab finds it: the
  // contract's settle is sized for a connect answered from memory, not for a
  // daemon round trip through a worker on a loaded machine.
  await source.snapshot(`workspace:${workspaceId}`)
  const backend = new SseBackend(workspaceId, 'canvas-a', BASE, undefined, source)
  return {
    backend,
    dropTransport: () => endStream?.(),
    localEdit: (snapshot) => {
      const tab = new LoroDoc()
      if (snapshot !== null) tab.import(snapshot)
      const from = tab.oplogVersion()
      tab.getMap('tab').set('edit', workspaceId)
      tab.commit()
      return {
        bytes: tab.export({ mode: 'update', from }),
        landed: () => keeper.getMap('tab').get('edit') === workspaceId,
      }
    },
    keeperWrites: keeperWriter(workspaceId, keeper),
    caughtUp: (delivered) => reproduces(delivered, keeper),
    // The worker outlives every case by design; disconnecting releases this
    // case's claims, and its workspace id keeps its traffic apart.
    cleanup: () => backend.disconnect(),
  }
}

describe('DocumentBackend contract: SseBackend over the SharedWorker', { timeout: 25_000 }, () => {
  documentBackendContract(harness)
})
