// @vitest-environment node
/**
 * The hub's reconnect loop against a daemon that goes away: how long it waits
 * between attempts, and what it remembers of a stream that ended. A daemon
 * that is down for hours is the case that finds an unbounded wait, and a
 * stream that ended is the case that finds a message addressed to a dead id.
 */
import { describe, expect, it, vi } from 'vitest'
import { defaultRetryDelayMs, SseStreamHub } from './sse-stream-hub.js'

type Step = 'refuse' | 'open' | 'hang'

/**
 * A daemon that answers each stream request from a script. A request past the
 * script's end hangs until aborted, which holds the hub in "reconnecting" so a
 * test can look at it there.
 */
function scriptedDaemon(script: readonly Step[]) {
  const controlBodies: { path: string; body: Record<string, unknown> }[] = []
  const ends: (() => void)[] = []
  let streamRequests = 0
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (!url.includes('/api/sync/stream')) {
      controlBodies.push({
        path: new URL(url).pathname,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      })
      return new Response('{}', { status: 200 })
    }
    const nth = streamRequests
    streamRequests += 1
    const step = script[nth] ?? 'hang'
    if (step === 'refuse') throw new TypeError('fetch failed')
    if (step === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')))
      })
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: ready\ndata: ${JSON.stringify({ streamId: `stream-${nth}` })}\n\n`,
            ),
          )
          ends.push(() => controller.close())
        },
      }),
      { status: 200 },
    )
  }
  return {
    fetch: fetch as typeof globalThis.fetch,
    streamRequests: () => streamRequests,
    /** Ends the most recent stream, as a daemon restart does. */
    endLatest: () => ends.at(-1)?.(),
    streamsOpened: () => ends.length,
    messages: () => controlBodies.filter((c) => c.path === '/api/sync/message').map((c) => c.body),
    subscribes: () =>
      controlBodies.filter((c) => c.path === '/api/sync/subscribe').map((c) => c.body),
  }
}

const waitFor = (condition: () => void) => vi.waitFor(condition)

describe('SseStreamHub reconnect schedule', () => {
  it('never waits longer than thirty seconds, however long the daemon has been down', () => {
    const waits = Array.from({ length: 41 }, (_, attempt) => defaultRetryDelayMs(attempt))
    expect(Math.max(...waits)).toBeLessThanOrEqual(30_000)
    // The ceiling is reached rather than merely respected, so a schedule that
    // collapsed to a short constant would not pass as bounded.
    expect(waits.at(-1)).toBe(30_000)
    expect(waits[0]).toBe(500)
    expect(waits).toEqual([...waits].sort((a, b) => a - b))
  })

  it('starts the backoff over once a stream has opened', async () => {
    const daemon = scriptedDaemon(['refuse', 'refuse', 'open', 'refuse'])
    const attempts: number[] = []
    const hub = new SseStreamHub({
      fetch: daemon.fetch,
      baseUrl: 'http://d',
      retryDelayMs: (attempt) => {
        attempts.push(attempt)
        return 0
      },
    })
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await waitFor(() => expect(daemon.streamsOpened()).toBe(1))
    daemon.endLatest()
    await waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(4))
    hub.close()

    // Two refusals grow it; the stream that opened and then ended resets it.
    expect(attempts.slice(0, 4)).toEqual([1, 2, 0, 1])
  })
})

describe('SseStreamHub after a stream ends', () => {
  it('declares ready on the next stream only the documents that declared it', async () => {
    const daemon = scriptedDaemon(['open', 'open'])
    const hub = new SseStreamHub({
      fetch: daemon.fetch,
      baseUrl: 'http://d',
      retryDelayMs: () => 0,
    })
    hub.subscribe('w/declared', { onUpdate: () => {}, onMessage: () => {} })
    hub.subscribe('w/silent', { onUpdate: () => {}, onMessage: () => {} })
    await waitFor(() => expect(daemon.streamsOpened()).toBe(1))
    hub.sendMessage('w/declared', { type: 'client_ready' })

    daemon.endLatest()
    await waitFor(() => expect(daemon.streamsOpened()).toBe(2))
    await waitFor(() =>
      expect(daemon.messages().filter((m) => m.streamId === 'stream-1').length).toBeGreaterThan(0),
    )
    hub.close()

    // A document that never declared itself is not announced as ready by a
    // reconnect: the daemon would route viewport requests to a canvas that
    // never asked for them.
    expect(daemon.messages().filter((m) => m.streamId === 'stream-1')).toEqual([
      { streamId: 'stream-1', doc: 'w/declared', message: { type: 'client_ready' } },
    ])
  })

  it('addresses nothing to the stream that ended while it waits for the next one', async () => {
    const daemon = scriptedDaemon(['open'])
    const hub = new SseStreamHub({
      fetch: daemon.fetch,
      baseUrl: 'http://d',
      retryDelayMs: () => 0,
    })
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await waitFor(() => expect(daemon.streamsOpened()).toBe(1))
    daemon.endLatest()
    // The second request hangs, so the hub is between streams from here on.
    await waitFor(() => expect(daemon.streamRequests()).toBe(2))
    const before = daemon.messages().length
    const subscribesBefore = daemon.subscribes().length

    hub.sendMessage('w/a', { type: 'client_ready' })
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: () => {} })
    hub.close()

    expect(daemon.messages().length).toBe(before)
    expect(daemon.subscribes().length).toBe(subscribesBefore)
  })
})
