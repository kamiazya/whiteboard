// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SseStreamHub } from './sse-stream-hub.js'

function createFake() {
  const calls: { url: string; body?: string }[] = []
  let push: ((frame: string) => void) | null = null
  let endStream: (() => void) | null = null
  let streamSeq = 0
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? String(init.body) : undefined })
    if (url.includes('/api/sync/stream')) {
      streamSeq += 1
      const id = `server-${streamSeq}`
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            // The daemon mints the id and announces it on the stream itself;
            // nothing can be addressed to a stream before this frame.
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
    return new Response('{}', { status: 200 })
  })
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    calls,
    push: (f: string) => push?.(f),
    /** Ends the stream the way a daemon restart or a dropped connection does. */
    endStream: () => endStream?.(),
    streamOpens: () => calls.filter((c) => c.url.includes('/api/sync/stream')).length,
    subscribeBodies: () =>
      calls.filter((c) => c.url.includes('/api/sync/subscribe')).map((c) => c.body ?? ''),
    messageBodies: () =>
      calls.filter((c) => c.url.includes('/api/sync/message')).map((c) => c.body ?? ''),
  }
}

/** Retries run immediately so a reconnect test asserts behavior, not timing. */
const noDelay = () => 0

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('SseStreamHub', () => {
  it('opens exactly one stream no matter how many documents subscribe', async () => {
    // The whole point: six HTTP/1.1 connections per origin is the budget, and a
    // stream per canvas would spend it on sync alone.
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d' })

    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: () => {} })
    await flush()

    expect(fake.calls.filter((c) => c.url.includes('/api/sync/stream')).length).toBe(1)
    hub.close()
  })

  it('tells the daemon to stop routing a document once its last listener leaves', async () => {
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d' })
    const off1 = hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    const off2 = hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await flush()

    off1()
    await flush()
    // Still one listener left, so the subscription must stay.
    expect(fake.subscribeBodies().some((b) => b.includes('unsubscribe'))).toBe(false)

    off2()
    await flush()
    expect(fake.subscribeBodies().some((b) => b.includes('"unsubscribe":["w/a"]'))).toBe(true)
    hub.close()
  })

  it('routes an update only to the listeners of that document', async () => {
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d' })
    const a: Uint8Array[] = []
    const b: Uint8Array[] = []
    hub.subscribe('w/a', { onUpdate: (u) => a.push(u), onMessage: () => {} })
    hub.subscribe('w/b', { onUpdate: (u) => b.push(u), onMessage: () => {} })
    await flush()

    fake.push(`event: update\ndata: ${JSON.stringify({ doc: 'w/b', update: btoa('\x05') })}\n\n`)
    await vi.waitFor(() => expect(b.length).toBe(1))

    expect(a).toEqual([])
    expect(b[0]).toEqual(new Uint8Array([5]))
    hub.close()
  })

  it('routes a text message only to the listeners of that document', async () => {
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d' })
    const a: string[] = []
    const b: string[] = []
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: (m) => a.push(m) })
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: (m) => b.push(m) })
    await flush()

    fake.push(`event: message\ndata: ${JSON.stringify({ doc: 'w/a', raw: '{"x":1}' })}\n\n`)
    await vi.waitFor(() => expect(a.length).toBe(1))

    expect(b).toEqual([])
    expect(a[0]).toBe('{"x":1}')
    hub.close()
  })

  it('reassembles a frame that arrives split across chunks', async () => {
    // The normal case on a real network, and the reason the frame parser is a
    // separate function rather than something the reader loop does inline.
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d' })
    const a: Uint8Array[] = []
    hub.subscribe('w/a', { onUpdate: (u) => a.push(u), onMessage: () => {} })
    await flush()

    const frame = `event: update\ndata: ${JSON.stringify({ doc: 'w/a', update: btoa('\x05') })}\n\n`
    const cut = Math.floor(frame.length / 2)
    fake.push(frame.slice(0, cut))
    await flush()
    // Nothing may be dispatched from half a frame.
    expect(a).toEqual([])

    fake.push(frame.slice(cut))
    await vi.waitFor(() => expect(a.length).toBe(1))
    expect(a[0]).toEqual(new Uint8Array([5]))
    hub.close()
  })

  it('reopens the stream after it drops and re-announces every subscription', async () => {
    // Without this a disconnected client keeps its listeners registered and
    // silently stops receiving updates — the worst failure mode available,
    // because the canvas still looks connected while it diverges.
    const fake = createFake()
    const hub = new SseStreamHub({
      fetch: fake.fetch,
      baseUrl: 'http://d',
      retryDelayMs: noDelay,
    })
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: () => {} })
    await vi.waitFor(() => expect(fake.streamOpens()).toBe(1))

    fake.endStream()

    await vi.waitFor(() => expect(fake.streamOpens()).toBe(2))
    // The daemon forgets a stream when it drops, so the subscriptions have to
    // be announced again against the reopened one.
    const afterReopen = fake.subscribeBodies().slice(-1)[0] ?? ''
    expect(afterReopen).toContain('w/a')
    expect(afterReopen).toContain('w/b')
    hub.close()
  })

  it('re-announces client_ready after a reconnect', async () => {
    // Viewport requests only reach a stream that has signalled readiness, so a
    // reconnected client that never repeats it goes silently unserved.
    const fake = createFake()
    const hub = new SseStreamHub({
      fetch: fake.fetch,
      baseUrl: 'http://d',
      retryDelayMs: noDelay,
    })
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await vi.waitFor(() => expect(fake.streamOpens()).toBe(1))
    hub.sendMessage('w/a', { type: 'client_ready' })
    await vi.waitFor(() => expect(fake.messageBodies().length).toBe(1))

    fake.endStream()

    await vi.waitFor(() => expect(fake.messageBodies().length).toBe(2))
    expect(fake.messageBodies()[1]).toContain('client_ready')
    hub.close()
  })

  it('stops reconnecting once closed', async () => {
    const fake = createFake()
    const hub = new SseStreamHub({
      fetch: fake.fetch,
      baseUrl: 'http://d',
      retryDelayMs: noDelay,
    })
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await vi.waitFor(() => expect(fake.streamOpens()).toBe(1))

    hub.close()
    fake.endStream()
    await flush()

    expect(fake.streamOpens()).toBe(1)
  })

  it('stays closed even if something subscribes afterwards', async () => {
    // Distinct from the case above, which holds because close() drops the
    // listeners: this pins that a closed hub does not quietly revive.
    const fake = createFake()
    const hub = new SseStreamHub({
      fetch: fake.fetch,
      baseUrl: 'http://d',
      retryDelayMs: noDelay,
    })
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await vi.waitFor(() => expect(fake.streamOpens()).toBe(1))
    hub.close()

    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await flush()

    expect(fake.streamOpens()).toBe(1)
  })
})
