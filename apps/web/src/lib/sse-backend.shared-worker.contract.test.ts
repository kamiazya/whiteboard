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
 * `refuseAuth` refuses the case's workspace on its subscribe, as the daemon
 * refuses a workspace the credential may not enter, rather than on the
 * stream: a stream refused halts the worker's stream for the origin until
 * every claim on it is released, which the other cases' reconnects would
 * otherwise trip over. `refuseStream` is the stream-level refusal, and lets go
 * of the harness's own claim so that release can happen.
 * For the same reason `streamOpens` counts the case's own subscribes, not
 * stream opens: on a shared stream, being asked for again IS a backend's
 * reconnect, and a refused workspace must not be asked for again on the
 * reopens other cases cause. `failsNextStreamOpen` fails that subscribe as a
 * dropped request, which the hub answers by reopening the stream after its
 * backoff. No `sentUpdates`: the
 * worker merges a push into its replica before writing onward, so arbitrary
 * bytes never reach the daemon — `localEdit` is a real Loro edit instead.
 * No `refusesNextWrite`: the worker announces a refusal only once it has
 * rebuilt its replica from the daemon, so the read a refusal sends a tab to
 * make is answered from that replica and cannot fail; how the source reports
 * a failed read is the SseStreamSource contract's.
 */
import { SseBackend } from '@kamiazya/whiteboard-daemon-client/sse-backend'
import type { SseStreamSource } from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
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
/** Workspaces whose keeper commits a write of its own once it has served a snapshot. */
const writeAfterSnapshot = new Set<string>()
/**
 * The keys the open stream carries: added when a subscribe for them is taken,
 * cleared with the stream, as the daemon's routing is. A frame reaches only
 * a routed key, and nothing is replayed.
 */
const routed = new Set<string>()
const keeperBroadcasts = new Map<string, (live: boolean) => void>()
/**
 * Workspace keys the daemon will not route, and how: `refused` answers the
 * subscribe 404, `silent` never answers it. The stream is the worker's and
 * shared by every case, so a case is made unroutable by its subscribe, not
 * by holding the stream back.
 */
const unroutable = new Map<string, 'refused' | 'silent'>()
/**
 * Snapshot reads still to answer 503, by workspace — a daemon restarting
 * under the worker's seed. An open costs the keeper two reads when the first
 * fails: the worker's feed seeds on routing, and the tab's request seeds again.
 */
const failingSnapshots = new Map<string, number>()
/** Workspace keys whose subscribe the daemon refuses as one the credential may not enter. */
const authRefused = new Set<string>()
/** Subscribes asked for each workspace key, refused ones included. */
const subscribesAsked = new Map<string, number>()
/** Workspace keys whose next subscribe fails as a dropped request does, as a daemon restarting under it. */
const failNextSubscribe = new Set<string>()
/** Answers the subscribes `silent` is holding, so none outlives its case. */
const heldSubscribes = new Map<string, () => void>()
/** Whether the daemon refuses the stream open itself for the credential. */
let refuseStreams = false
let pushFrame: ((frame: string) => void) | null = null
let endStream: (() => void) | null = null

const sseFrame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

/**
 * The daemon taking a subscribe after the request's own latency, so a read
 * the client sends beside it is served before the routing exists — the
 * window a real network leaves open.
 */
async function routeAfter(latencyMs: number, docs: readonly string[]): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, latencyMs))
  if (pushFrame === null) return
  for (const doc of docs) routed.add(doc)
}

const server = setupServer(
  http.get(`${BASE}/api/sync/stream`, () => {
    if (refuseStreams) return HttpResponse.json({ title: 'unauthorized' }, { status: 401 })
    const enc = new TextEncoder()
    routed.clear()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(sseFrame('ready', { streamId: 'worker-contract' })))
        pushFrame = (frame) => controller.enqueue(enc.encode(frame))
        // Every case's transport is this one stream, so two backends dropped
        // in the same tick are one drop, not a second close of it.
        endStream = () => {
          endStream = null
          pushFrame = null
          routed.clear()
          controller.close()
        }
      },
    })
    return new HttpResponse(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }),
  http.post(`${BASE}/api/sync/subscribe`, async ({ request }) => {
    const body = (await request.json()) as { subscribe?: string[]; unsubscribe?: string[] }
    for (const doc of body.unsubscribe ?? []) routed.delete(doc)
    for (const doc of body.subscribe ?? [])
      subscribesAsked.set(doc, (subscribesAsked.get(doc) ?? 0) + 1)
    if ((body.subscribe ?? []).some((doc) => failNextSubscribe.delete(doc)))
      return HttpResponse.error()
    if ((body.subscribe ?? []).some((doc) => authRefused.has(doc))) {
      return HttpResponse.json({ error: 'not_a_member' }, { status: 403 })
    }
    const refusing = (body.subscribe ?? []).find((doc) => unroutable.has(doc))
    if (refusing !== undefined && unroutable.get(refusing) === 'refused') {
      return HttpResponse.json({ error: 'unknown_stream' }, { status: 404 })
    }
    if (refusing !== undefined) {
      await new Promise<void>((resolve) => heldSubscribes.set(refusing, resolve))
      return HttpResponse.json({ error: 'unknown_stream' }, { status: 404 })
    }
    await routeAfter(20, body.subscribe ?? [])
    return HttpResponse.json({ ok: true })
  }),
  http.post(`${BASE}/api/sync/message`, () => HttpResponse.json({ ok: true })),
  http.get(`${BASE}/api/w/:workspaceId/workspace-document/snapshot`, ({ params }) => {
    const workspaceId = String(params.workspaceId)
    const failing = failingSnapshots.get(workspaceId) ?? 0
    if (failing > 0) {
      failingSnapshots.set(workspaceId, failing - 1)
      return HttpResponse.json({ title: 'unavailable' }, { status: 503 })
    }
    const keeper = keepers.get(workspaceId)
    if (!keeper) return HttpResponse.json({ title: 'not found' }, { status: 404 })
    const snapshot = keeper.export({ mode: 'snapshot' })
    if (writeAfterSnapshot.delete(workspaceId)) keeperBroadcasts.get(workspaceId)?.(true)
    return new HttpResponse(snapshot.slice().buffer as ArrayBuffer, {
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

// The contract polls each connect against a ceiling, which a cold worker still
// loading loro's WASM does not meet. Its replica answering, and a stream open
// for it, are the warm worker every later case meets anyway.
beforeAll(async () => {
  const source = createSharedSseStreamSource(BASE, fetch)
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

/** The keeper's own writes, broadcast on the open stream when `live` and the stream carries them. */
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
    const doc = `workspace:${workspaceId}`
    if (!routed.has(doc)) return
    pushFrame?.(sseFrame('update', { doc, update: bytesToBase64(update) }))
  }
}

let caseSeq = 0

/** A case's daemon-side document, with content to tell a real snapshot from an empty one. */
function seededKeeper(workspaceId: string): LoroDoc {
  const keeper = new LoroDoc()
  keeper.getText('t').insert(0, 'seed')
  keeper.commit()
  keepers.set(workspaceId, keeper)
  return keeper
}

/** A real Loro edit built against `snapshot`, as a tab's is, and whether the keeper took it. */
function tabEdit(workspaceId: string, keeper: LoroDoc, snapshot: Uint8Array | null) {
  const tab = new LoroDoc()
  if (snapshot !== null) tab.import(snapshot)
  const from = tab.oplogVersion()
  tab.getMap('tab').set('edit', workspaceId)
  tab.commit()
  return {
    bytes: tab.export({ mode: 'update', from }),
    landed: () => keeper.getMap('tab').get('edit') === workspaceId,
  }
}

/**
 * The harness's own claim on the worker's one stream, released at most once.
 * The stream outlives the case that dropped it and reopens only while
 * something subscribes, so holding a claim for the case brings it back up and
 * every case starts from a transport that is.
 */
function holdStreamFor(source: SseStreamSource, workspaceId: string): () => void {
  const claim = source.subscribe(`workspace:${workspaceId}-stream`, {
    onUpdate: () => {},
    onMessage: () => {},
  })
  let held = true
  return () => {
    if (held) claim()
    held = false
  }
}

/**
 * The stream is refused for every claim on it, and a refused stream is asked
 * for again only once all of them are released, so the harness's hold goes.
 */
function refuseStream(releaseHold: () => void): () => void {
  refuseStreams = true
  releaseHold()
  return () => {
    refuseStreams = false
  }
}

let otherSeq = 0

/** A backend for a further document of its own, through the same worker. */
function anotherBackend(workspaceId: string, source: SseStreamSource): SseBackend {
  const other = `${workspaceId}-other-${++otherSeq}`
  seededKeeper(other)
  return new SseBackend(other, 'canvas-b', BASE, undefined, source)
}

async function harness(): Promise<DocumentBackendHarness> {
  const source = createSharedSseStreamSource(BASE, fetch)
  if (!source) throw new Error('SharedWorker unavailable')
  const workspaceId = `worker-contract-${++caseSeq}`
  const keeper = seededKeeper(workspaceId)
  const keeperWrites = keeperWriter(workspaceId, keeper)
  keeperBroadcasts.set(workspaceId, keeperWrites)
  const holdStream = holdStreamFor(source, workspaceId)
  await vi.waitFor(() => expect(pushFrame).not.toBeNull(), { timeout: 15_000 })
  const backend = new SseBackend(workspaceId, 'canvas-a', BASE, undefined, source)
  return {
    backend,
    dropTransport: () => endStream?.(),
    refuseAuth: () => {
      authRefused.add(`workspace:${workspaceId}`)
    },
    refuseStream: () => refuseStream(holdStream),
    anotherBackend: () => anotherBackend(workspaceId, source),
    streamOpens: () => subscribesAsked.get(`workspace:${workspaceId}`) ?? 0,
    failsNextStreamOpen: () => {
      failNextSubscribe.add(`workspace:${workspaceId}`)
    },
    localEdit: (snapshot) => tabEdit(workspaceId, keeper, snapshot),
    keeperWrites,
    keeperWritesAfterNextSnapshot: () => {
      writeAfterSnapshot.add(workspaceId)
    },
    neverRoutes: (how) => {
      unroutable.set(`workspace:${workspaceId}`, how)
    },
    failsOpeningRead: () => {
      failingSnapshots.set(workspaceId, 2)
    },
    caughtUp: (delivered) => reproduces(delivered, keeper),
    // The worker outlives every case by design; disconnecting releases this
    // case's claims, and its workspace id keeps its traffic apart.
    cleanup: () => {
      refuseStreams = false
      backend.disconnect()
      holdStream()
      heldSubscribes.get(`workspace:${workspaceId}`)?.()
    },
  }
}

describe('DocumentBackend contract: SseBackend over the SharedWorker', { timeout: 25_000 }, () => {
  documentBackendContract(harness)
})
