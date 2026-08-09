// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SseStreamHub } from './sse-stream-hub.js'

function createFake() {
  const calls: { url: string; body?: string }[] = []
  let push: ((frame: string) => void) | null = null
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? String(init.body) : undefined })
    if (url.includes('/api/sync/stream')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            push = (f) => controller.enqueue(enc.encode(f))
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
    subscribeBodies: () =>
      calls.filter((c) => c.url.includes('/api/sync/subscribe')).map((c) => c.body ?? ''),
  }
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('SseStreamHub', () => {
  it('opens exactly one stream no matter how many documents subscribe', async () => {
    // The whole point: six HTTP/1.1 connections per origin is the budget, and a
    // stream per canvas would spend it on sync alone.
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d', streamId: 's' })

    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: () => {} })
    await flush()

    expect(fake.calls.filter((c) => c.url.includes('/api/sync/stream')).length).toBe(1)
    hub.close()
  })

  it('tells the daemon to stop routing a document once its last listener leaves', async () => {
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d', streamId: 's' })
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
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d', streamId: 's' })
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
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d', streamId: 's' })
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
})
