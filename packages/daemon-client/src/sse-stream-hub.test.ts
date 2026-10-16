// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SseStreamHub } from './sse-stream-hub.js'
import { flush } from './test-utils/flush.js'

function createFake() {
  const calls: { url: string; body?: string }[] = []
  let push: ((frame: string) => void) | null = null
  let endStream: (() => void) | null = null
  let streamSeq = 0
  /** What the daemon answers instead of a stream or an update, once told to refuse. */
  let refusal: { stream?: number; update?: number } = {}
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? String(init.body) : undefined })
    if (url.includes('/api/sync/stream') && refusal.stream !== undefined) {
      return new Response('{"title":"unauthorized"}', { status: refusal.stream })
    }
    if (url.endsWith('/update') && refusal.update !== undefined) {
      return new Response('{"title":"forbidden"}', { status: refusal.update })
    }
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
    /** From now on the daemon answers this status instead of what was asked. */
    refuse: (next: { stream?: number; update?: number }) => {
      refusal = next
    },
    streamOpens: () => calls.filter((c) => c.url.includes('/api/sync/stream')).length,
    subscribeBodies: () =>
      calls.filter((c) => c.url.includes('/api/sync/subscribe')).map((c) => c.body ?? ''),
    messageBodies: () =>
      calls.filter((c) => c.url.includes('/api/sync/message')).map((c) => c.body ?? ''),
  }
}

/** Retries run immediately so a reconnect test asserts behavior, not timing. */
const noDelay = () => 0

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

  it('drops an update frame whose payload is not base64 and keeps reading the stream', async () => {
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d' })
    const seen: Uint8Array[] = []
    hub.subscribe('w/a', { onUpdate: (u) => seen.push(u), onMessage: () => {} })
    await flush()

    fake.push(`event: update\ndata: ${JSON.stringify({ doc: 'w/a', update: 'not base64!' })}\n\n`)
    fake.push(`event: update\ndata: ${JSON.stringify({ doc: 'w/a', update: btoa('\x07') })}\n\n`)
    await vi.waitFor(() => expect(seen.length).toBe(1))

    expect(seen[0]).toEqual(new Uint8Array([7]))
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

  it('is undisturbed by a keep-alive between two real frames', async () => {
    // What a hub-level test can see: a keep-alive delivers nothing and the
    // stream stays live. That the frame is dropped by the PARSER rather than
    // absorbed downstream is `parseSseEvent`'s own test in sse-frames.test.ts — every
    // consumer in `dispatch` re-validates, so this one passes either way.
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d' })
    const messages: string[] = []
    const updates: Uint8Array[] = []
    hub.subscribe('w/a', { onUpdate: (u) => updates.push(u), onMessage: (m) => messages.push(m) })
    await flush()

    fake.push(': keep-alive\n\n')
    fake.push('event: message\n\n')
    await flush()
    expect(messages).toEqual([])
    expect(updates).toEqual([])

    // The stream is still live: a real frame after them still arrives.
    fake.push(`event: message\ndata: ${JSON.stringify({ doc: 'w/a', raw: '{"x":1}' })}\n\n`)
    await vi.waitFor(() => expect(messages.length).toBe(1))
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

  it('stops replaying client_ready for a document it no longer watches', async () => {
    // Readiness is replayed on reconnect, so a document that was left behind
    // would keep declaring this stream ready for it — and the daemon would keep
    // routing viewport requests nobody is listening for.
    const fake = createFake()
    const hub = new SseStreamHub({
      fetch: fake.fetch,
      baseUrl: 'http://d',
      retryDelayMs: noDelay,
    })
    const off = hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {} })
    await vi.waitFor(() => expect(fake.streamOpens()).toBe(1))
    hub.sendMessage('w/a', { type: 'client_ready' })
    await vi.waitFor(() => expect(fake.messageBodies().length).toBe(1))

    off()
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: () => {} })
    fake.endStream()

    await vi.waitFor(() => expect(fake.streamOpens()).toBe(2))
    await flush()
    expect(fake.messageBodies().filter((b) => b.includes('w/a'))).toHaveLength(1)
    hub.close()
  })

  it('tells its subscribers when the stream drops and when it comes back', async () => {
    // Without this a caller cannot distinguish "nothing has changed" from
    // "nothing is arriving", and the UI reports a connection that is gone.
    const fake = createFake()
    const hub = new SseStreamHub({
      fetch: fake.fetch,
      baseUrl: 'http://d',
      retryDelayMs: noDelay,
    })
    const states: boolean[] = []
    hub.subscribe('w/a', {
      onUpdate: () => {},
      onMessage: () => {},
      onConnectionChange: (connected) => states.push(connected),
    })

    // The first entry is the state at subscribe time — no stream yet.
    await vi.waitFor(() => expect(states).toEqual([false, true]))
    fake.endStream()

    await vi.waitFor(() => expect(states).toEqual([false, true, false, true]))
    hub.close()
  })

  it('tells a late subscriber the state of the document it just joined', async () => {
    // Routing announced only on transitions leaves anyone who subscribes to an
    // already-routed document with no idea whether it is live — a second canvas
    // opened in the same workspace would show an unknown connection forever.
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d', retryDelayMs: noDelay })
    // Wait on the first subscriber actually observing the open stream, not on
    // the fetch call: the ready frame is parsed later, and a second subscriber
    // registered in that window would be told by the transition itself.
    const first: boolean[] = []
    hub.subscribe('w/a', {
      onUpdate: () => {},
      onMessage: () => {},
      onConnectionChange: (c) => first.push(c),
    })
    await vi.waitFor(() => expect(first).toEqual([false, true]))

    const states: boolean[] = []
    hub.subscribe('w/a', {
      onUpdate: () => {},
      onMessage: () => {},
      onConnectionChange: (connected) => states.push(connected),
    })

    expect(states).toEqual([true])
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

    // Closing cancels the read, so the stream ends here as a dropped one would.
    hub.close()
    await flush()

    expect(fake.streamOpens()).toBe(1)
  })

  it('tells every subscriber the daemon refused the session, and stops reconnecting', async () => {
    // A refused credential is not a dropped connection: retrying it is a
    // 401 every backoff step for as long as the tab stays open, while the
    // UI reads the silence as "reconnecting". The listener is told once per
    // refusal and the loop halts, so the page can say the session is off.
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d', retryDelayMs: noDelay })
    const refused = vi.fn()
    const states: boolean[] = []
    hub.subscribe('w/a', {
      onUpdate: () => {},
      onMessage: () => {},
      onConnectionChange: (c) => states.push(c),
      onAuthRefused: refused,
    })
    await vi.waitFor(() => expect(states).toContain(true))

    fake.refuse({ stream: 401 })
    fake.endStream()
    await vi.waitFor(() => expect(refused).toHaveBeenCalledTimes(1))
    await flush()

    // One reconnect attempt met the refusal; nothing after it.
    expect(fake.streamOpens()).toBe(2)
    expect(states.at(-1)).toBe(false)
    hub.close()
  })

  describe('announcing what it follows', () => {
    /** The fake daemon, answering a subscribe naming `refusedWorkspace` with `status`. */
    function refusing(refusedWorkspace: string, status: number) {
      const fake = createFake()
      const inner = fake.fetch
      const asked: string[][] = []
      const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes('/api/sync/subscribe')) {
          const body = JSON.parse(String(init?.body)) as { subscribe?: string[] }
          asked.push(body.subscribe ?? [])
          if (body.subscribe?.some((doc) => doc.startsWith(`${refusedWorkspace}/`))) {
            return new Response('{}', { status })
          }
        }
        return inner(input, init)
      }) as typeof globalThis.fetch
      return { fake, fetch, asked }
    }

    const quiet = { onUpdate: () => {}, onMessage: () => {} }

    it('asks for one workspace per request, so a refusal reaches only its own documents', async () => {
      const { fake, fetch, asked } = refusing('gone', 403)
      const hub = new SseStreamHub({ fetch, baseUrl: 'http://d' })
      const refused = { gone: vi.fn(), live: vi.fn() }
      hub.subscribe('live/a', { ...quiet, onAuthRefused: refused.live })
      hub.subscribe('gone/b', { ...quiet, onAuthRefused: refused.gone })
      hub.subscribe('live/c', { ...quiet, onAuthRefused: refused.live })
      await vi.waitFor(() => expect(refused.gone).toHaveBeenCalledTimes(1))

      expect(refused.live).not.toHaveBeenCalled()
      expect(asked).toEqual([['live/a', 'live/c'], ['gone/b']])
      // The stream stays: it still carries the documents that were not refused.
      expect(fake.streamOpens()).toBe(1)
      hub.close()
    })

    describe('after a workspace refuses the credential', () => {
      /** A hub following `gone/b` (refused) before `live/a`, so a reconnect asks for `gone/b` first. */
      async function refusedOnce() {
        const { fake, fetch, asked } = refusing('gone', 403)
        const hub = new SseStreamHub({ fetch, baseUrl: 'http://d', retryDelayMs: noDelay })
        const refused = vi.fn()
        const live: boolean[] = []
        const offGone = hub.subscribe('gone/b', { ...quiet, onAuthRefused: refused })
        hub.subscribe('live/a', { ...quiet, onConnectionChange: (c) => live.push(c) })
        await vi.waitFor(() => expect(refused).toHaveBeenCalledTimes(1))
        await vi.waitFor(() => expect(live.filter(Boolean)).toHaveLength(1))
        const goneAsks = () => asked.filter((docs) => docs.includes('gone/b')).length
        return { fake, hub, refused, live, offGone, goneAsks }
      }

      it('asks for it no more on a reconnect, and reports the refusal once', async () => {
        // The same credential gets the same answer on every stream, so asking
        // again only tells the page a refusal it already shows, once per drop.
        const { fake, hub, refused, live, goneAsks } = await refusedOnce()
        fake.endStream()
        // `live/a` is asked after `gone/b`, so its routing on the new stream
        // means a re-ask for `gone/b` would already have been sent.
        await vi.waitFor(() => expect(live.filter(Boolean)).toHaveLength(2))
        await flush()

        expect(fake.streamOpens()).toBe(2)
        expect(goneAsks()).toBe(1)
        expect(refused).toHaveBeenCalledTimes(1)
        hub.close()
      })

      it('asks again once the document is released and subscribed afresh', async () => {
        // Reopening is how a membership granted since is reached.
        const { hub, refused, offGone, goneAsks } = await refusedOnce()
        offGone()
        const again = vi.fn()
        hub.subscribe('gone/b', { ...quiet, onAuthRefused: again })
        await vi.waitFor(() => expect(again).toHaveBeenCalledTimes(1))

        expect(goneAsks()).toBe(2)
        expect(refused).toHaveBeenCalledTimes(1)
        hub.close()
      })

      it('tells a listener joining the refused document, without asking again', async () => {
        const { hub, refused, goneAsks } = await refusedOnce()
        const joined = vi.fn()
        hub.subscribe('gone/b', { ...quiet, onAuthRefused: joined })

        expect(joined).toHaveBeenCalledTimes(1)
        // The refusal is the joiner's news alone; whoever already heard it is not told again.
        expect(refused).toHaveBeenCalledTimes(1)
        expect(goneAsks()).toBe(1)
        hub.close()
      })

      it('declares readiness on a reconnect only for the documents it asks for again', async () => {
        // The new stream never carries the refused document, so its readiness
        // would address a routing that does not exist, under the credential
        // that was just refused.
        const { fake, hub, live } = await refusedOnce()
        hub.sendMessage('gone/b', { type: 'client_ready' })
        hub.sendMessage('live/a', { type: 'client_ready' })
        fake.endStream()
        await vi.waitFor(() => expect(live.filter(Boolean)).toHaveLength(2))
        const replayed = () =>
          fake
            .messageBodies()
            .map((b) => JSON.parse(b) as { streamId: string; doc: string })
            .filter((m) => m.streamId === 'server-2')
            .map((m) => m.doc)
        await vi.waitFor(() => expect(replayed()).toContain('live/a'))

        expect(replayed()).not.toContain('gone/b')
        hub.close()
      })

      it('hands a joiner its unsubscribe even when its refusal listener throws', async () => {
        const { hub } = await refusedOnce()
        const throwing = vi.fn(() => {
          throw new Error('listener failed')
        })
        const unsubscribe = hub.subscribe('gone/b', { ...quiet, onAuthRefused: throwing })

        expect(throwing).toHaveBeenCalledTimes(1)
        expect(unsubscribe).toBeTypeOf('function')
        hub.close()
      })
    })

    it('says a document is not live when the daemon would not follow it, for a late subscriber too', async () => {
      const { fetch } = refusing('full', 400)
      const hub = new SseStreamHub({ fetch, baseUrl: 'http://d' })
      const states: boolean[] = []
      hub.subscribe('ok/a', quiet)
      hub.subscribe('full/b', { ...quiet, onConnectionChange: (c) => states.push(c) })
      // Never `true`: the stream is open, but it does not carry this document.
      await vi.waitFor(() => expect(states).toEqual([false, false]))

      const late: boolean[] = []
      hub.subscribe('full/b', { ...quiet, onConnectionChange: (c) => late.push(c) })
      expect(late).toEqual([false])
      hub.close()
    })

    // 404 is a stream the daemon no longer knows (a restart race), 400 a
    // request past its limit: neither is the credential, so the next stream
    // asks again and nobody is told the session was refused.
    it.each([
      404, 400,
    ])('asks again on the next stream after a %i refusal, never calling it the credential', async (status) => {
      const { fake, fetch, asked } = refusing('full', status)
      const hub = new SseStreamHub({ fetch, baseUrl: 'http://d', retryDelayMs: noDelay })
      const refused = vi.fn()
      const live: boolean[] = []
      hub.subscribe('full/b', { ...quiet, onAuthRefused: refused })
      hub.subscribe('live/a', { ...quiet, onConnectionChange: (c) => live.push(c) })
      await vi.waitFor(() => expect(live.filter(Boolean)).toHaveLength(1))
      const joined = vi.fn()
      hub.subscribe('full/b', { ...quiet, onAuthRefused: joined })
      fake.endStream()
      // `full/b` is asked before `live/a`, so `live/a` routed on the new
      // stream means the re-ask for `full/b` has already been sent.
      await vi.waitFor(() => expect(live.filter(Boolean)).toHaveLength(2))
      await flush()

      expect(asked.filter((docs) => docs.includes('full/b'))).toHaveLength(2)
      expect(refused).not.toHaveBeenCalled()
      expect(joined).not.toHaveBeenCalled()
      hub.close()
    })

    it('never puts more than a request may carry in one subscribe', async () => {
      const fake = createFake()
      const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d' })
      for (let i = 0; i < 300; i++) hub.subscribe(`w/doc-${i}`, quiet)
      await vi.waitFor(() => expect(fake.subscribeBodies().length).toBeGreaterThanOrEqual(2))

      const sizes = fake.subscribeBodies().map((b) => JSON.parse(b).subscribe.length)
      expect(Math.max(...sizes)).toBeLessThanOrEqual(256)
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(300)
      hub.close()
    })
  })

  it('tells a document’s subscribers when a push for it is refused, and still rejects', async () => {
    // The stream can stay open under a credential the daemon no longer
    // accepts for WRITES (a membership revoked mid-session answers 403 on
    // the update route alone), so the push is the only place the refusal
    // can be seen. The rejection is kept: the caller still owns the bytes.
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d', retryDelayMs: noDelay })
    const refused = vi.fn()
    const other = vi.fn()
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: refused })
    hub.subscribe('w/b', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: other })
    await vi.waitFor(() => expect(fake.streamOpens()).toBe(1))

    fake.refuse({ update: 403 })
    await expect(hub.push('w/a', new Uint8Array([1]))).rejects.toThrow('403')

    expect(refused).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    hub.close()
  })

  it('still asks for a document on a reconnect after a push for it was refused', async () => {
    // Reading and writing are separate scopes: a credential holding only the
    // read one is refused every push and still entitled to the stream, so a
    // refused push must not stop the document being followed.
    const fake = createFake()
    const hub = new SseStreamHub({ fetch: fake.fetch, baseUrl: 'http://d', retryDelayMs: noDelay })
    hub.subscribe('w/a', { onUpdate: () => {}, onMessage: () => {}, onAuthRefused: () => {} })
    const asks = () => fake.subscribeBodies().filter((b) => b.includes('"subscribe":["w/a"]'))
    await vi.waitFor(() => expect(asks()).toHaveLength(1))
    fake.refuse({ update: 403 })
    await expect(hub.push('w/a', new Uint8Array([1]))).rejects.toThrow('403')

    fake.endStream()
    await vi.waitFor(() => expect(asks()).toHaveLength(2))
    hub.close()
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
