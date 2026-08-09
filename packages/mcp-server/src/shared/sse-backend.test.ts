// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SseBackend } from './sse-backend.js'

function sseFrame(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

/** A fetch stand-in that serves the snapshot, the stream, and records POSTs. */
function createFakeTransport(streamFrames: string[]) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  let pushFrame: ((frame: string) => void) | null = null
  let closeStream: (() => void) | null = null

  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body })

    if (url.includes('/snapshot')) {
      return new Response(new Uint8Array([7, 7, 7]), { status: 200 })
    }
    if (url.includes('/api/sync/stream')) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          // The daemon mints the stream id and announces it before anything
          // else; the client cannot address a stream until it arrives.
          controller.enqueue(
            encoder.encode(`event: ready\ndata: ${JSON.stringify({ streamId: 'server-1' })}\n\n`),
          )
          for (const frame of streamFrames) controller.enqueue(encoder.encode(frame))
          pushFrame = (frame) => controller.enqueue(encoder.encode(frame))
          closeStream = () => controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })

  return {
    transport: { fetch: fetch as unknown as typeof globalThis.fetch },
    calls,
    push: (frame: string) => pushFrame?.(frame),
    close: () => closeStream?.(),
  }
}

function createHandlers() {
  const snapshots: Uint8Array[] = []
  const updates: Uint8Array[] = []
  let connected = 0
  return {
    handlers: {
      onSnapshot: (b: Uint8Array) => snapshots.push(b),
      onRemoteUpdate: (b: Uint8Array) => updates.push(b),
      onConnected: () => {
        connected += 1
      },
      onVersionCreated: () => {},
      onRestoreStarted: () => {},
      onRestoreComplete: () => {},
      onHeadChanged: () => {},
      onViewportRequest: () => {},
      onExportRequest: () => {},
    } as never,
    snapshots,
    updates,
    connectedCount: () => connected,
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('SseBackend', () => {
  it('seeds the document from the binary snapshot route, not from the stream', async () => {
    // Routing the largest payload through SSE would only add base64 inflation,
    // so the snapshot keeps its existing binary endpoint.
    const fake = createFakeTransport([])
    const { handlers, snapshots } = createHandlers()
    const backend = new SseBackend('ws-1', 'canvas-a', 'http://127.0.0.1:3099', fake.transport)

    backend.connect(handlers)
    await vi.waitFor(() => expect(snapshots.length).toBe(1))

    expect(snapshots[0]).toEqual(new Uint8Array([7, 7, 7]))
    expect(fake.calls.some((c) => c.url.includes('/api/canvas/ws-1/canvas-a/snapshot'))).toBe(true)
    backend.disconnect()
  })

  it('drops a snapshot that finishes reading after disconnect', async () => {
    // Reading the body is a second await, so a disconnect can land between the
    // response arriving and its bytes being decoded. Seeding a document the
    // caller has already torn down would resurrect state it deliberately left.
    let releaseBody: (() => void) | null = null
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/snapshot')) {
        return {
          ok: true,
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((resolve) => {
              releaseBody = () => resolve(new Uint8Array([1]).buffer)
            }),
        } as unknown as Response
      }
      return new Response('{}', { status: 200 })
    })
    const { handlers, snapshots } = createHandlers()
    const backend = new SseBackend('ws-1', 'canvas-a', 'http://127.0.0.1:3099', {
      fetch: fetch as unknown as typeof globalThis.fetch,
    })

    backend.connect(handlers)
    await vi.waitFor(() => expect(releaseBody).not.toBeNull())
    backend.disconnect()
    releaseBody?.()
    await flush()

    expect(snapshots).toEqual([])
  })

  it('subscribes the stream to its own document', async () => {
    const fake = createFakeTransport([])
    const { handlers } = createHandlers()
    const backend = new SseBackend('ws-1', 'canvas-a', 'http://127.0.0.1:3099', fake.transport)

    backend.connect(handlers)
    await vi.waitFor(() => {
      const sub = fake.calls.find((c) => c.url.includes('/api/sync/subscribe'))
      expect(sub).toBeDefined()
      expect(String(sub?.body)).toContain('ws-1/canvas-a')
    })
    backend.disconnect()
  })

  it('decodes a base64 update frame back into the original bytes', async () => {
    const fake = createFakeTransport([])
    const { handlers, updates } = createHandlers()
    const backend = new SseBackend('ws-1', 'canvas-a', 'http://127.0.0.1:3099', fake.transport)

    backend.connect(handlers)
    await flush()
    fake.push(
      sseFrame('update', JSON.stringify({ doc: 'ws-1/canvas-a', update: btoa('\x01\x02\xff') })),
    )

    await vi.waitFor(() => expect(updates.length).toBe(1))
    expect(updates[0]).toEqual(new Uint8Array([1, 2, 255]))
    backend.disconnect()
  })

  it('ignores an update addressed to a different document', async () => {
    // One stream serves many documents, so every frame carries its doc key and
    // a backend must drop the ones that are not its own.
    const fake = createFakeTransport([])
    const { handlers, updates } = createHandlers()
    const backend = new SseBackend('ws-1', 'canvas-a', 'http://127.0.0.1:3099', fake.transport)

    backend.connect(handlers)
    await flush()
    fake.push(sseFrame('update', JSON.stringify({ doc: 'ws-1/other', update: btoa('\x09') })))
    await flush()

    expect(updates).toEqual([])
    backend.disconnect()
  })

  it('ignores a text message addressed to a different document', async () => {
    // The misrouting this addressing exists to prevent: a head_changed for a
    // sibling canvas sharing the stream must not be applied here.
    const fake = createFakeTransport([])
    const heads: unknown[] = []
    const handlers = {
      onSnapshot: () => {},
      onRemoteUpdate: () => {},
      onConnected: () => {},
      onVersionCreated: () => {},
      onRestoreStarted: () => {},
      onRestoreComplete: () => {},
      onHeadChanged: (h: unknown) => heads.push(h),
      onViewportRequest: () => {},
      onExportRequest: () => {},
    } as never
    const backend = new SseBackend('ws-1', 'canvas-a', 'http://127.0.0.1:3099', fake.transport)

    backend.connect(handlers)
    await flush()
    const headChanged = JSON.stringify({ type: 'head_changed', head: 'other-head' })
    fake.push(sseFrame('message', JSON.stringify({ doc: 'ws-1/other', raw: headChanged })))
    await flush()
    expect(heads).toEqual([])

    // …while the same message for this document is applied.
    fake.push(sseFrame('message', JSON.stringify({ doc: 'ws-1/canvas-a', raw: headChanged })))
    await vi.waitFor(() => expect(heads.length).toBe(1))
    backend.disconnect()
  })

  it('sends a local update to the existing canvas update route', async () => {
    const fake = createFakeTransport([])
    const { handlers } = createHandlers()
    const backend = new SseBackend('ws-1', 'canvas-a', 'http://127.0.0.1:3099', fake.transport)

    backend.connect(handlers)
    await flush()
    backend.pushLocalUpdate(new Uint8Array([4, 5]))

    await vi.waitFor(() => {
      const post = fake.calls.find(
        (c) => c.url.includes('/api/canvas/ws-1/canvas-a/update') && c.method === 'POST',
      )
      expect(post).toBeDefined()
    })
    backend.disconnect()
  })

  it('reports client_ready over the HTTP control channel', async () => {
    const fake = createFakeTransport([])
    const { handlers } = createHandlers()
    const backend = new SseBackend('ws-1', 'canvas-a', 'http://127.0.0.1:3099', fake.transport)

    backend.connect(handlers)
    await flush()
    backend.sendClientReady()

    await vi.waitFor(() => {
      const post = fake.calls.find((c) => c.url.includes('/api/sync/message'))
      expect(post).toBeDefined()
      expect(String(post?.body)).toContain('client_ready')
    })
    backend.disconnect()
  })

  it('routes control messages through an injected stream source', async () => {
    // The shipped configuration injects the SharedWorker-backed source, so the
    // stream — and therefore the streamId the daemon knows — belongs to the
    // worker. A control message addressed with this backend's own id would
    // reach the daemon as an unknown stream and be dropped, taking viewport
    // and export delivery with it.
    const fake = createFakeTransport([])
    const { handlers } = createHandlers()
    const sent: { doc: string; message: unknown }[] = []
    const source = {
      subscribe: () => () => {},
      sendMessage: (doc: string, message: unknown) => sent.push({ doc, message }),
    }
    const backend = new SseBackend(
      'ws-1',
      'canvas-a',
      'http://127.0.0.1:3099',
      fake.transport,
      source,
    )

    backend.connect(handlers)
    await flush()
    backend.sendClientReady()
    backend.sendExportResponse('req-1', 'data:image/png;base64,AAA')

    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(sent[0]).toEqual({ doc: 'ws-1/canvas-a', message: { type: 'client_ready' } })
    expect(sent[1]?.message).toEqual({
      type: 'export_response',
      requestId: 'req-1',
      data: 'data:image/png;base64,AAA',
    })
    expect(fake.calls.some((c) => c.url.includes('/api/sync/message'))).toBe(false)
    backend.disconnect()
  })
})
