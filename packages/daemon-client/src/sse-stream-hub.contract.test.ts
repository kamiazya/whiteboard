// @vitest-environment node
// The hub half of the SseStreamSource contract. Its sibling runs the same
// cases against the SharedWorker-backed source in apps/web, which is the
// implementation the app actually ships.
import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import { describe, vi } from 'vitest'
import { SseStreamHub } from './sse-stream-hub.js'
import type { SseStreamSourceHarness } from './test-utils/sse-stream-source-contract.js'
import { sseStreamSourceContract } from './test-utils/sse-stream-source-contract.js'

const BASE = 'http://d'

/**
 * The daemon's canvas snapshot route: the state seeded for a document, 404
 * for one it does not know, 503 once for a read set to fail. `null` for a URL
 * that is not this route.
 */
function snapshotRoute() {
  const state = new Map<string, Uint8Array>()
  const failing = new Set<string>()
  const answer = (url: string): Response | null => {
    const match = /\/api\/w\/([^/]+)\/document\/(.+)\/snapshot$/.exec(url)
    if (!match) return null
    const [, workspaceId, path] = match
    const doc = `${decodeURIComponent(workspaceId as string)}/${decodeURIComponent(path as string)}`
    if (failing.delete(doc)) return new Response('{"title":"unavailable"}', { status: 503 })
    const bytes = state.get(doc)
    if (!bytes) return new Response('{"title":"Canvas not found"}', { status: 404 })
    return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })
  }
  return { state, failing, answer }
}

/** Whether a subscribe body asks for any of `docs`. */
const names = (body: { subscribe?: string[] }, docs: ReadonlySet<string>): boolean =>
  (body.subscribe ?? []).some((doc) => docs.has(doc))

/** The daemon refusing the credential for one workspace. */
const forbidden = () => new Response('{"title":"forbidden"}', { status: 403 })

/** A daemon stand-in: mints a stream id, records the POSTs, pushes frames. */
function createHarness(): SseStreamSourceHarness {
  let streamSeq = 0
  const openedStreamIds: string[] = []
  const subscribeBodies: { subscribe?: string[]; unsubscribe?: string[] }[] = []
  const controlMessages: { streamId: string; doc: string; message: unknown }[] = []
  const daemonWrites: { doc: string; body: Uint8Array }[] = []
  const snapshots = snapshotRoute()
  let push: ((frame: string) => void) | null = null
  let endStream: (() => void) | null = null
  let refuseStreams = false
  const refusedDocs = new Set<string>()
  const refusedPushes = new Set<string>()

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/sync/stream') && refuseStreams) {
      return new Response('{"title":"unauthorized"}', { status: 401 })
    }
    if (url.includes('/api/sync/stream')) {
      streamSeq += 1
      const id = `hub-stream-${streamSeq}`
      openedStreamIds.push(id)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            controller.enqueue(
              enc.encode(`event: ready\ndata: ${JSON.stringify({ streamId: id })}\n\n`),
            )
            push = (f) => controller.enqueue(enc.encode(f))
            endStream = () => controller.close()
          },
        }),
        { status: 200 },
      )
    }
    // The canvas update route, which is where a push lands. Matched before the
    // JSON parse below: its body is raw update bytes, not JSON.
    const snapshot = snapshots.answer(url)
    if (snapshot !== null) return snapshot
    const canvasUpdate = /\/api\/w\/([^/]+)\/document\/(.+)\/update$/.exec(url)
    if (canvasUpdate) {
      const [, handle, path] = canvasUpdate
      const doc = `${decodeURIComponent(handle as string)}/${decodeURIComponent(path as string)}`
      if (refusedPushes.has(doc)) return forbidden()
      daemonWrites.push({ doc, body: new Uint8Array(init?.body as ArrayBuffer) })
      return new Response('{}', { status: 200 })
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (url.includes('/api/sync/subscribe')) subscribeBodies.push(body)
    if (url.includes('/api/sync/subscribe') && names(body, refusedDocs)) return forbidden()
    if (url.includes('/api/sync/message')) controlMessages.push(body)
    return new Response('{}', { status: 200 })
  })

  const hub = new SseStreamHub({
    fetch: fetch as unknown as typeof globalThis.fetch,
    baseUrl: BASE,
  })

  return {
    source: hub,
    pushUpdate: (doc, bytes) => {
      push?.(`event: update\ndata: ${JSON.stringify({ doc, update: bytesToBase64(bytes) })}\n\n`)
    },
    pushText: (doc, raw) => {
      push?.(`event: message\ndata: ${JSON.stringify({ doc, raw })}\n\n`)
    },
    subscribedDocs: () => subscribeBodies.flatMap((b) => b.subscribe ?? []),
    unsubscribedDocs: () => subscribeBodies.flatMap((b) => b.unsubscribe ?? []),
    controlMessages: () => controlMessages,
    openedStreamIds: () => openedStreamIds,
    daemonWrites: () => daemonWrites,
    seedDaemonState: (doc, bytes) => snapshots.state.set(doc, bytes),
    failsNextRead: (doc) => snapshots.failing.add(doc),
    ready: async () => {
      await vi.waitFor(() => {
        if (push === null) throw new Error('stream not open')
      })
    },
    dropStream: () => endStream?.(),
    refuseAuth: () => {
      refuseStreams = true
    },
    refuseSubscribe: (doc) => refusedDocs.add(doc),
    refusePush: (doc) => refusedPushes.add(doc),
    cleanup: () => hub.close(),
  }
}

describe('SseStreamSource contract: SseStreamHub', () => {
  sseStreamSourceContract(createHarness)
})
