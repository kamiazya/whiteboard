// @vitest-environment node
/**
 * What `onConnectionChange` promises: that the daemon ROUTES the document
 * into the open stream, not merely that a stream is open. The stream replays
 * nothing, so a subscriber that read its state on "open" could miss a write
 * the daemon took before the subscribe landed — and every later frame builds
 * on that write.
 */
import { describe, expect, it, vi } from 'vitest'
import { routingTransitions, SseStreamHub } from './sse-stream-hub.js'
import { flush } from './test-utils/flush.js'

/** A daemon whose subscribe answers wait until the case releases them, in order. */
function heldSubscribes() {
  const held: (() => void)[] = []
  let endStream: (() => void) | null = null
  let streamSeq = 0
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/api/sync/subscribe')) {
      await new Promise<void>((answer) => held.push(answer))
      return new Response('{}', { status: 200 })
    }
    if (url.includes('/api/sync/stream')) {
      const id = `routed-${++streamSeq}`
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const ready = `event: ready\ndata: ${JSON.stringify({ streamId: id })}\n\n`
            controller.enqueue(new TextEncoder().encode(ready))
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
    held: () => held.length,
    /** Answer the oldest subscribe still waiting. */
    answer: () => held.shift()?.(),
    endStream: () => endStream?.(),
  }
}

function watch(hub: SseStreamHub, doc: string): boolean[] {
  const states: boolean[] = []
  hub.subscribe(doc, {
    onUpdate: () => {},
    onMessage: () => {},
    onConnectionChange: (connected) => states.push(connected),
  })
  return states
}

describe('SseStreamHub routing', () => {
  it('takes no subscribe answer that lands between two streams as routing', async () => {
    // The old stream has dropped and the next has not said `ready`, so no
    // stream is open — and the count of streams has not moved yet, so only
    // the absent id says the answer speaks for a routing the daemon forgot.
    // Taken as routing, the page reads its state on it, and the real routing
    // on the next stream is never announced.
    const held: (() => void)[] = []
    let endStream: (() => void) | null = null
    let openSecond: (() => void) | null = null
    let streams = 0
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/api/sync/subscribe')) {
        await new Promise<void>((answer) => held.push(answer))
        return new Response('{}', { status: 200 })
      }
      if (!url.includes('/api/sync/stream')) return new Response('{}', { status: 200 })
      const id = `gap-${++streams}`
      if (streams === 2) await new Promise<void>((open) => (openSecond = open))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const ready = `event: ready\ndata: ${JSON.stringify({ streamId: id })}\n\n`
            controller.enqueue(new TextEncoder().encode(ready))
            endStream = () => controller.close()
          },
        }),
        { status: 200 },
      )
    })
    const hub = new SseStreamHub({
      fetch: fetch as unknown as typeof globalThis.fetch,
      baseUrl: 'http://d',
      retryDelayMs: () => 0,
    })
    const states = watch(hub, 'workspace:a')
    await vi.waitFor(() => expect(held).toHaveLength(1))
    endStream?.()
    await vi.waitFor(() => expect(openSecond).not.toBeNull())

    held.shift()?.()
    await flush()
    expect(states).not.toContain(true)

    openSecond?.()
    await vi.waitFor(() => expect(held).toHaveLength(1))
    held.shift()?.()
    await vi.waitFor(() => expect(states.at(-1)).toBe(true))
    hub.close()
  })

  it('says a document is connected only once the daemon has answered its subscribe', async () => {
    const daemon = heldSubscribes()
    const hub = new SseStreamHub({ fetch: daemon.fetch, baseUrl: 'http://d' })
    const states = watch(hub, 'workspace:a')

    await vi.waitFor(() => expect(daemon.held()).toBe(1))
    expect(states).toEqual([false])

    daemon.answer()
    await vi.waitFor(() => expect(states).toEqual([false, true]))
    hub.close()
  })

  it('says it again after a reconnect only once the re-subscribe is answered', async () => {
    const daemon = heldSubscribes()
    const hub = new SseStreamHub({
      fetch: daemon.fetch,
      baseUrl: 'http://d',
      retryDelayMs: () => 0,
    })
    const states = watch(hub, 'workspace:a')
    await vi.waitFor(() => expect(daemon.held()).toBe(1))
    daemon.answer()
    await vi.waitFor(() => expect(states).toEqual([false, true]))

    daemon.endStream()
    await vi.waitFor(() => expect(daemon.held()).toBe(1))
    expect(states).toEqual([false, true, false])

    daemon.answer()
    await vi.waitFor(() => expect(states).toEqual([false, true, false, true]))
    hub.close()
  })

  it('takes no answer for a stream that has since dropped as routing on the next', async () => {
    const daemon = heldSubscribes()
    const hub = new SseStreamHub({
      fetch: daemon.fetch,
      baseUrl: 'http://d',
      retryDelayMs: () => 0,
    })
    const states = watch(hub, 'workspace:a')
    await vi.waitFor(() => expect(daemon.held()).toBe(1))

    daemon.endStream()
    await vi.waitFor(() => expect(daemon.held()).toBe(2))
    // The first stream's subscribe answers late: the daemon forgot that
    // stream's routing when it ended, so this says nothing about the new one.
    daemon.answer()
    await flush()
    expect(states).not.toContain(true)

    daemon.answer()
    await vi.waitFor(() => expect(states.at(-1)).toBe(true))
    expect(states.filter((s) => s)).toEqual([true])
    hub.close()
  })

  it('takes no answer for a released subscription as routing for the one that replaced it', async () => {
    const daemon = heldSubscribes()
    const hub = new SseStreamHub({ fetch: daemon.fetch, baseUrl: 'http://d' })
    const off = hub.subscribe('workspace:a', { onUpdate: () => {}, onMessage: () => {} })
    await vi.waitFor(() => expect(daemon.held()).toBe(1))
    off()
    const states = watch(hub, 'workspace:a')
    // The release and the new subscribe are both still on their way.
    await vi.waitFor(() => expect(daemon.held()).toBe(3))

    daemon.answer()
    await flush()
    expect(states).toEqual([false])

    daemon.answer()
    daemon.answer()
    await vi.waitFor(() => expect(states).toEqual([false, true]))
    hub.close()
  })
})

describe('SseStreamHub when a subscribe goes unanswered', () => {
  it('opens a new stream and asks again, rather than leaving the document unrouted', async () => {
    let subscribes = 0
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/api/sync/subscribe')) {
        subscribes += 1
        if (subscribes === 1) throw new TypeError('network error')
        return new Response('{}', { status: 200 })
      }
      if (url.includes('/api/sync/stream')) {
        const ready = `event: ready\ndata: ${JSON.stringify({ streamId: `s-${subscribes}` })}\n\n`
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(ready))
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const hub = new SseStreamHub({ fetch, baseUrl: 'http://d', retryDelayMs: () => 0 })
    const states = watch(hub, 'workspace:a')

    await vi.waitFor(() => expect(states.at(-1)).toBe(true))
    expect(subscribes).toBe(2)
    hub.close()
  })
})

describe('routingTransitions', () => {
  function recorded() {
    const calls: string[] = []
    const next = routingTransitions({
      first: () => calls.push('first'),
      resumed: () => calls.push('resumed'),
    })
    return { calls, next }
  }

  it('reads the first true as the start, even after a false that came before it', () => {
    const { calls, next } = recorded()
    next(false)
    next(true)
    expect(calls).toEqual(['first'])
  })

  it('reads a true after a drop as resumed, once however many falls came between', () => {
    const { calls, next } = recorded()
    next(true)
    next(false)
    next(false)
    next(true)
    expect(calls).toEqual(['first', 'resumed'])
  })

  it('reads a true repeated without a drop between as nothing missed', () => {
    const { calls, next } = recorded()
    next(true)
    next(true)
    next(false)
    next(true)
    next(true)
    expect(calls).toEqual(['first', 'resumed'])
  })

  it('needs no start handler', () => {
    const resumed = vi.fn()
    const next = routingTransitions({ resumed })
    next(false)
    next(true)
    next(false)
    next(true)
    expect(resumed).toHaveBeenCalledTimes(1)
  })
})
