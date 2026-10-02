// @vitest-environment node
// The SSE backend against the shared DocumentBackend contract. The backend
// over a workspace kept in the browser runs the same cases from apps/web,
// where its store lives.
import { describe, vi } from 'vitest'
import { SseBackend } from './sse-backend.js'
import type { DocumentBackendHarness } from './test-utils/document-backend-contract.js'
import { documentBackendContract } from './test-utils/document-backend-contract.js'

const BASE = 'http://127.0.0.1:3099'

/** Records what a backend POSTs upstream and serves the routes it reads. */
let endStream: (() => void) | null = null
let refuseStreams = false

function createFetch(sent: Uint8Array[]) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/sync/stream') && refuseStreams) {
      return new Response('{"title":"unauthorized"}', { status: 401 })
    }
    if (url.includes('/snapshot')) return new Response(new Uint8Array([1, 1, 1]), { status: 200 })
    if (url.includes('/update')) {
      const body = init?.body
      if (body instanceof ArrayBuffer) sent.push(new Uint8Array(body))
      return new Response('{}', { status: 200 })
    }
    if (url.includes('/api/sync/stream')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: ready\ndata: ${JSON.stringify({ streamId: 'contract-stream' })}\n\n`,
              ),
            )
            endStream = () => controller.close()
          },
        }),
        { status: 200 },
      )
    }
    // A file the canvas does not have. 404 is what the daemon answers.
    if (url.includes('/file/')) return new Response('not found', { status: 404 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof globalThis.fetch
}

describe('DocumentBackend contract: SseBackend', () => {
  documentBackendContract((): DocumentBackendHarness => {
    const sent: Uint8Array[] = []
    refuseStreams = false
    const backend = new SseBackend('ws-1', 'canvas-a', BASE, { fetch: createFetch(sent) })
    return {
      backend,
      sentUpdates: () => sent,
      dropTransport: () => endStream?.(),
      refuseAuth: () => {
        refuseStreams = true
      },
      cleanup: () => backend.disconnect(),
    }
  })
})
