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

  it('grows the backoff when every subscribe on an opened stream goes unanswered', async () => {
    // The stream opens and its subscribe fails at the network, which ends
    // the stream. Counted as a stream that opened, that would reopen it at
    // the floor delay forever, re-routing every healthy document each time.
    const attempts: number[] = []
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/sync/subscribe')) throw new TypeError('fetch failed')
      if (!url.includes('/api/sync/stream')) return new Response('{}', { status: 200 })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: ready\ndata: ${JSON.stringify({ streamId: 's' })}\n\n`,
              ),
            )
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
          },
        }),
        { status: 200 },
      )
    }
    const hub = new SseStreamHub({
      fetch: fetch as typeof globalThis.fetch,
      baseUrl: 'http://d',
      retryDelayMs: (attempt) => {
        attempts.push(attempt)
        return 0
      },
    })
    hub.subscribe('workspace:w', { onUpdate: () => {}, onMessage: () => {} })
    await waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(4))
    hub.close()

    expect(attempts.slice(0, 4)).toEqual([1, 2, 3, 4])
  })

  it('starts the backoff over for a healthy stream after an unanswered one', async () => {
    // Whether a subscribe went unanswered is a fact about ONE stream: carried
    // over, a single lost subscribe would grow the wait after every later
    // healthy stream that ends, as a daemon restart ends one.
    const attempts: number[] = []
    let subscribes = 0
    const ends: (() => void)[] = []
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/sync/subscribe')) {
        subscribes += 1
        if (subscribes === 1) throw new TypeError('fetch failed')
        return new Response('{}', { status: 200 })
      }
      if (!url.includes('/api/sync/stream')) return new Response('{}', { status: 200 })
      const streamId = `s${ends.length}`
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`event: ready\ndata: ${JSON.stringify({ streamId })}\n\n`),
            )
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
            ends.push(() => controller.close())
          },
        }),
        { status: 200 },
      )
    }
    const hub = new SseStreamHub({
      fetch: fetch as typeof globalThis.fetch,
      baseUrl: 'http://d',
      retryDelayMs: (attempt) => {
        attempts.push(attempt)
        return 0
      },
    })
    hub.subscribe('workspace:w', { onUpdate: () => {}, onMessage: () => {} })
    await waitFor(() => expect(subscribes).toBe(2))
    await waitFor(() => expect(ends.length).toBe(2))
    ends[1]?.()
    await waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(2))
    hub.close()

    expect(attempts.slice(0, 2)).toEqual([1, 0])
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

describe('stream connect refusals', () => {
  /** Answers each stream request with a status code, `open` or a hang past the script. */
  function statusDaemon(script: readonly (number | 'open')[]) {
    let streamRequests = 0
    let opened = 0
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/api/sync/stream')) return new Response('{}', { status: 200 })
      const step = script[streamRequests]
      streamRequests += 1
      if (step === 'open') {
        opened += 1
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  `event: ready\ndata: ${JSON.stringify({ streamId: 's' })}\n\n`,
                ),
              )
            },
          }),
          { status: 200 },
        )
      }
      if (typeof step === 'number') return new Response('', { status: step })
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')))
      })
    }
    return {
      fetch: fetch as typeof globalThis.fetch,
      requests: () => streamRequests,
      opened: () => opened,
    }
  }

  it('retries a 503 on the stream connect rather than reading it as a credential refusal', async () => {
    const d = statusDaemon([503, 'open'])
    const hub = new SseStreamHub({ fetch: d.fetch, baseUrl: 'http://d', retryDelayMs: () => 0 })
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await vi.waitFor(() => expect(d.opened()).toBe(1))
    hub.close()
  })

  it('stops the retry loop on a 401 from the stream connect', async () => {
    const d = statusDaemon([401, 'open', 'open'])
    const hub = new SseStreamHub({ fetch: d.fetch, baseUrl: 'http://d', retryDelayMs: () => 0 })
    const refused = vi.fn()
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: refused })
    // The hub marks itself refused before it announces, so by the time the
    // callback arrives the loop can no longer connect again: the count holds
    // without waiting on time.
    await vi.waitFor(() => expect(refused).toHaveBeenCalledTimes(1))
    expect(d.requests()).toBe(1)
    expect(d.opened()).toBe(0)
    hub.close()
  })

  // A hub can outlive every page that opened it — the SharedWorker keeps one
  // per origin — so a refusal of the stream has to reach whoever subscribes
  // later, and must not outlast everyone who heard it.
  it('tells a document subscribing after a refused stream open, without asking again', async () => {
    const d = statusDaemon([401, 'open'])
    const hub = new SseStreamHub({ fetch: d.fetch, baseUrl: 'http://d', retryDelayMs: () => 0 })
    const first = vi.fn()
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: first })
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    const joiner = vi.fn()
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: joiner })
    expect(joiner).toHaveBeenCalledTimes(1)
    // A second listener on the document that already heard it: only the
    // newcomer is told, not the listener told at the refusal.
    const sameDoc = vi.fn()
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: sameDoc })
    expect(sameDoc).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    // Someone still holds the refusal, so the halt holds too.
    expect(d.requests()).toBe(1)
    hub.close()
  })

  it('opens the stream again once every document that heard the refusal is released', async () => {
    const d = statusDaemon([401, 'open'])
    const hub = new SseStreamHub({ fetch: d.fetch, baseUrl: 'http://d', retryDelayMs: () => 0 })
    const refused = vi.fn()
    const release = hub.subscribe('w/a', {
      onUpdate: () => {},
      onMessage: () => {},
      onAuthRefused: refused,
    })
    await vi.waitFor(() => expect(refused).toHaveBeenCalledTimes(1))
    release()
    const again = vi.fn()
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: again })
    await vi.waitFor(() => expect(d.opened()).toBe(1))
    expect(again).not.toHaveBeenCalled()
    hub.close()
  })

  it('keeps the halt while another document still holds the refusal', async () => {
    const d = statusDaemon([401, 'open'])
    const hub = new SseStreamHub({ fetch: d.fetch, baseUrl: 'http://d', retryDelayMs: () => 0 })
    const b = vi.fn()
    const releaseA = hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: b })
    await vi.waitFor(() => expect(b).toHaveBeenCalledTimes(1))
    releaseA()

    const newcomer = vi.fn()
    hub.subscribe('w/c', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: newcomer })
    // Told at once, so the halt held: a cleared one would have started a new stream instead.
    expect(newcomer.mock.calls).toEqual([['stream']])
    expect(d.requests()).toBe(1)
    hub.close()
  })

  // A refusal that lands once nobody is subscribed describes nobody: kept, it
  // would refuse the next subscriber without the daemon being asked again.
  it('asks again for a document subscribing after a refusal nobody was left to hear', async () => {
    let requests = 0
    let answerFirst: (res: Response) => void = () => {}
    let refusalRead: () => void = () => {}
    const read = new Promise<void>((resolve) => {
      refusalRead = resolve
    })
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (!String(input).includes('/api/sync/stream')) return new Response('{}', { status: 200 })
      requests += 1
      if (requests === 1) return new Promise<Response>((resolve) => (answerFirst = resolve))
      return new Response(new ReadableStream<Uint8Array>(), { status: 200 })
    }
    const hub = new SseStreamHub({ fetch, baseUrl: 'http://d', retryDelayMs: () => 0 })
    const release = hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await vi.waitFor(() => expect(requests).toBe(1))
    release()
    // The hub cancels a refused open's body, which is how the test knows it has read the answer.
    answerFirst(new Response(new ReadableStream({ cancel: () => refusalRead() }), { status: 401 }))
    await read

    const refused = vi.fn()
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: refused })
    await vi.waitFor(() => expect(requests).toBe(2))
    expect(refused).not.toHaveBeenCalled()
    hub.close()
  })

  // The open was asked for a lifetime that ended at the release, so its answer
  // describes that lifetime alone: the document subscribing meanwhile gets an
  // open of its own rather than the old one's verdict.
  it('asks again for a document that subscribed while a released open was pending', async () => {
    let requests = 0
    let answerFirst: (res: Response) => void = () => {}
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      if (!String(input).includes('/api/sync/stream')) return new Response('{}', { status: 200 })
      requests += 1
      if (requests === 1) return new Promise<Response>((resolve) => (answerFirst = resolve))
      return new Response(new ReadableStream<Uint8Array>(), { status: 200 })
    }
    const hub = new SseStreamHub({ fetch, baseUrl: 'http://d', retryDelayMs: () => 0 })
    const release = hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await vi.waitFor(() => expect(requests).toBe(1))
    release()
    const refused = vi.fn()
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: refused })
    answerFirst(new Response('', { status: 401 }))

    await vi.waitFor(() => expect(requests).toBe(2))
    expect(refused).not.toHaveBeenCalled()
    hub.close()
  })
})
