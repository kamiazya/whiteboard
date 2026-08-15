// @vitest-environment node
// The hub half of the SseStreamSource contract. Its sibling runs the same
// cases against the SharedWorker-backed source in apps/web, which is the
// implementation the app actually ships.
import { describe, vi } from 'vitest'
import { SseStreamHub } from './sse-stream-hub.js'
import type { SseStreamSourceHarness } from './test-utils/sse-stream-source-contract.js'
import { sseStreamSourceContract } from './test-utils/sse-stream-source-contract.js'

const BASE = 'http://d'

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** A daemon stand-in: mints a stream id, records the POSTs, pushes frames. */
function createHarness(): SseStreamSourceHarness {
  let streamSeq = 0
  const openedStreamIds: string[] = []
  const subscribeBodies: { subscribe?: string[]; unsubscribe?: string[] }[] = []
  const controlMessages: { streamId: string; doc: string; message: unknown }[] = []
  const daemonWrites: { doc: string; body: Uint8Array }[] = []
  const daemonState = new Map<string, Uint8Array>()
  let push: ((frame: string) => void) | null = null
  let endStream: (() => void) | null = null

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
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
    const canvasSnapshot = /\/api\/w\/([^/]+)\/canvas\/(.+)\/snapshot$/.exec(url)
    if (canvasSnapshot) {
      const [, workspaceId, slug] = canvasSnapshot
      const doc = `${decodeURIComponent(workspaceId as string)}/${decodeURIComponent(slug as string)}`
      const bytes = daemonState.get(doc)
      if (!bytes) return new Response('{"title":"Canvas not found"}', { status: 404 })
      return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })
    }
    const canvasUpdate = /\/api\/w\/([^/]+)\/canvas\/(.+)\/update$/.exec(url)
    if (canvasUpdate) {
      const [, workspaceId, slug] = canvasUpdate
      daemonWrites.push({
        doc: `${decodeURIComponent(workspaceId as string)}/${decodeURIComponent(slug as string)}`,
        body: new Uint8Array(init?.body as ArrayBuffer),
      })
      return new Response('{}', { status: 200 })
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (url.includes('/api/sync/subscribe')) subscribeBodies.push(body)
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
      push?.(`event: update\ndata: ${JSON.stringify({ doc, update: toBase64(bytes) })}\n\n`)
    },
    pushText: (doc, raw) => {
      push?.(`event: message\ndata: ${JSON.stringify({ doc, raw })}\n\n`)
    },
    subscribedDocs: () => subscribeBodies.flatMap((b) => b.subscribe ?? []),
    unsubscribedDocs: () => subscribeBodies.flatMap((b) => b.unsubscribe ?? []),
    controlMessages: () => controlMessages,
    openedStreamIds: () => openedStreamIds,
    daemonWrites: () => daemonWrites,
    seedDaemonState: (doc, bytes) => daemonState.set(doc, bytes),
    ready: async () => {
      await vi.waitFor(() => {
        if (push === null) throw new Error('stream not open')
      })
    },
    dropStream: () => endStream?.(),
    cleanup: () => hub.close(),
  }
}

describe('SseStreamSource contract: SseStreamHub', () => {
  sseStreamSourceContract(createHarness)
})
