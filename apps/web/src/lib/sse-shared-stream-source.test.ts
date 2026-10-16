/**
 * The failure mode this covers is not a thrown error: a module shared worker
 * whose chunk fails to load constructs FINE and reports through `onerror`
 * afterwards. The try/catch around the constructor cannot see that, so before
 * this the port was a hole — every subscribe posted into it, nothing answered,
 * and the page went quiet. The source now moves to the page's own stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '../test-utils/json-response.js'
import { BRIDGE_DAEMON_BASE_URL } from './bridge-address.js'
import { createSharedSseStreamSource as create } from './sse-shared-stream-source.js'

type ErrorHandler = ((event: { message?: string }) => void) | null

class FakeSharedWorker {
  static instances: FakeSharedWorker[] = []
  onerror: ErrorHandler = null
  readonly port = {
    postMessage: vi.fn(),
    start: vi.fn(),
    onmessage: null as ((e: MessageEvent) => void) | null,
  }
  constructor() {
    FakeSharedWorker.instances.push(this)
  }
  fail() {
    this.onerror?.({ message: 'chunk failed to load' })
  }
}

const original = globalThis.SharedWorker

beforeEach(() => {
  FakeSharedWorker.instances = []
  globalThis.SharedWorker = FakeSharedWorker as unknown as typeof SharedWorker
})
// A source is cached against its origin for the module's lifetime, and every case fails its workers on the way out, so each run of
// a case takes origins of its own: a repeated run must not inherit the last
// run's failure.
let run = 0
beforeEach(() => {
  run += 1
})
const origin = (name: string) => `http://${name}-${run}.test`

afterEach(() => {
  for (const worker of FakeSharedWorker.instances) worker.fail()
  globalThis.SharedWorker = original
})

/**
 * The page's own daemon, as far as a stream of its own needs one: a stream
 * that announces itself and then carries whatever the case pushes, a
 * snapshot route, and a subscribe route that answers.
 */
function ownStreamDaemon() {
  let push: ((frame: string) => void) | null = null
  const streamOpens: string[] = []
  const requested: string[] = []
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/api/sync/stream')) {
      streamOpens.push(url)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder()
            controller.enqueue(enc.encode('event: ready\ndata: {"streamId":"own"}\n\n'))
            push = (frame) => controller.enqueue(enc.encode(frame))
          },
        }),
      )
    }
    if (url.endsWith('/snapshot')) return new Response(new Uint8Array([9]))
    return jsonResponse({ ok: true })
  })
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    streamOpens,
    requested: () => requested,
    pushUpdate: (doc: string, bytes: string) =>
      push?.(`event: update\ndata: ${JSON.stringify({ doc, update: bytes })}\n\n`),
    streamOpen: () => push !== null,
  }
}

/** A daemon fetch for a case that never reaches the page's own stream: nothing answers. */
const unanswered = (() => new Promise<Response>(() => {})) as typeof fetch

/** The source for a case that does not care which fetch the page's own stream would use. */
const createSharedSseStreamSource = (baseUrl: string) => create(baseUrl, unanswered)

const postedAfterFailure = (type: string, before: number) => postedOfType(type).slice(before)

describe('a shared worker that fails to load', () => {
  it('tells its listeners they are disconnected instead of going quiet', () => {
    const source = createSharedSseStreamSource(origin('disconnected'))
    expect(source).not.toBeNull()
    const onConnectionChange = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onConnectionChange })

    FakeSharedWorker.instances[0]?.fail()

    expect(onConnectionChange).toHaveBeenCalledWith(false)
  })

  it('is remembered, so the next caller for that origin is served without a worker', async () => {
    const daemon = ownStreamDaemon()
    create(origin('evicted'), daemon.fetch)
    expect(FakeSharedWorker.instances).toHaveLength(1)
    FakeSharedWorker.instances[0]?.fail()

    // A missing chunk or a CSP refusal is the same on every attempt, so a
    // fresh worker would fail the same way: the origin's source is kept, and
    // serves from the page's own stream.
    const again = create(origin('evicted'), unanswered)
    expect(FakeSharedWorker.instances).toHaveLength(1)
    again?.subscribe('workspace:w', { onUpdate: vi.fn(), onMessage: vi.fn() })
    await vi.waitFor(() => expect(daemon.streamOpens).toHaveLength(1))
    createSharedSseStreamSource(origin('elsewhere'))
    expect(FakeSharedWorker.instances).toHaveLength(2)
  })

  it('hands a listener that resubscribes on the drop the page stream, not the port', async () => {
    const daemon = ownStreamDaemon()
    const source = create(origin('reconnect'), daemon.fetch)
    const onUpdate = vi.fn()
    let resubscribed = false
    source?.subscribe('workspace:w', {
      onUpdate: vi.fn(),
      onMessage: vi.fn(),
      onConnectionChange: (connected) => {
        if (connected || resubscribed) return
        resubscribed = true
        source.subscribe('workspace:w', { onUpdate, onMessage: vi.fn() })
      },
    })
    const posted = postedOfType('subscribe').length

    FakeSharedWorker.instances[0]?.fail()
    await vi.waitFor(() => expect(daemon.streamOpen()).toBe(true))
    daemon.pushUpdate('workspace:w', 'AQID')

    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    expect(postedAfterFailure('subscribe', posted)).toEqual([])
  })

  it('releases a listener that lets go while it is told of the drop', async () => {
    const daemon = ownStreamDaemon()
    const source = create(origin('lets-go'), daemon.fetch)
    const onUpdate = vi.fn()
    const kept = vi.fn()
    source?.subscribe('workspace:w', { onUpdate: kept, onMessage: vi.fn() })
    const off = source?.subscribe('workspace:w', {
      onUpdate,
      onMessage: vi.fn(),
      onConnectionChange: (connected) => {
        if (!connected) off?.()
      },
    })

    FakeSharedWorker.instances[0]?.fail()
    await vi.waitFor(() => expect(daemon.streamOpen()).toBe(true))
    daemon.pushUpdate('workspace:w', 'AQID')

    await vi.waitFor(() => expect(kept).toHaveBeenCalledTimes(1))
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('releases a moved listener from the page stream when its holder lets go', async () => {
    const daemon = ownStreamDaemon()
    const source = create(origin('moved-off'), daemon.fetch)
    const onUpdate = vi.fn()
    const kept = vi.fn()
    source?.subscribe('workspace:w', { onUpdate: kept, onMessage: vi.fn() })
    const off = source?.subscribe('workspace:w', { onUpdate, onMessage: vi.fn() })

    FakeSharedWorker.instances[0]?.fail()
    off?.()
    await vi.waitFor(() => expect(daemon.streamOpen()).toBe(true))
    daemon.pushUpdate('workspace:w', 'AQID')

    await vi.waitFor(() => expect(kept).toHaveBeenCalledTimes(1))
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('rejects a snapshot it was still waiting on', async () => {
    const source = createSharedSseStreamSource(origin('pending-snapshot'))
    const pending = source?.snapshot('workspace:w')

    FakeSharedWorker.instances[0]?.fail()

    await expect(pending).rejects.toThrow()
  })

  it("answers every later snapshot from the page's own read, not the dead port", async () => {
    const daemon = ownStreamDaemon()
    const source = create(origin('later-snapshot'), daemon.fetch)
    FakeSharedWorker.instances[0]?.fail()

    await expect(source?.snapshot('workspace:w')).resolves.toEqual(new Uint8Array([9]))
    expect(postedOfType('snapshot-request')).toEqual([])
  })

  it("sends control messages on the page's own stream once the worker has failed", async () => {
    const daemon = ownStreamDaemon()
    const source = create(origin('later-control'), daemon.fetch)
    source?.subscribe('workspace:w', { onUpdate: vi.fn(), onMessage: vi.fn() })
    FakeSharedWorker.instances[0]?.fail()
    await vi.waitFor(() => expect(daemon.streamOpen()).toBe(true))

    source?.sendMessage('workspace:w', { type: 'client_ready' })

    await vi.waitFor(() =>
      expect(daemon.requested().some((url) => url.endsWith('/api/sync/message'))).toBe(true),
    )
    expect(postedOfType('control')).toEqual([])
  })

  it("writes through the page's own stream once the worker has failed", async () => {
    const daemon = ownStreamDaemon()
    const source = create(origin('later-push'), daemon.fetch)
    FakeSharedWorker.instances[0]?.fail()

    await source?.push('workspace:w', new Uint8Array([1]))

    expect(postedOfType('push')).toEqual([])
    expect(daemon.requested().some((url) => url.endsWith('/update'))).toBe(true)
  })
})

describe('a shared worker that fails under a live listener', () => {
  // The source falls back inside itself, so a holder that never rebuilds is
  // not cut off for the page's life.
  it('keeps delivering to a listener that never rebuilds, through the page', async () => {
    const daemon = ownStreamDaemon()
    const source = create(origin('keeps-delivering'), daemon.fetch)
    const onUpdate = vi.fn()
    source?.subscribe('workspace:w', { onUpdate, onMessage: vi.fn() })

    FakeSharedWorker.instances[0]?.fail()
    await vi.waitFor(() => expect(daemon.streamOpen()).toBe(true))
    daemon.pushUpdate('workspace:w', 'AQID')

    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith(new Uint8Array([1, 2, 3])))
  })
})

describe("the worker's word on a document's writes", () => {
  // A tab's push returns before the keeper answers, so this event is the only
  // way a page learns its edit did not land — and that it later did.
  it('reaches the listener for that document, and no other', () => {
    const source = createSharedSseStreamSource(origin('write-state'))
    const mine = vi.fn()
    const other = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onWriteState: mine })
    source?.subscribe('w/other', { onUpdate: vi.fn(), onMessage: vi.fn(), onWriteState: other })
    const deliver = (data: unknown) =>
      FakeSharedWorker.instances[0]?.port.onmessage?.({ data } as MessageEvent)

    deliver({ type: 'write-state', doc: 'w/doc', landed: false })
    deliver({ type: 'write-state', doc: 'w/doc', landed: true })

    expect(mine.mock.calls).toEqual([[false], [true]])
    expect(other).not.toHaveBeenCalled()
  })
})

describe("the worker's word that the daemon refused a write for good", () => {
  it('reaches the listener for that document with the reason, and no other', () => {
    const source = createSharedSseStreamSource(origin('write-refused'))
    const mine = vi.fn()
    const other = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onWriteRefused: mine })
    source?.subscribe('w/other', { onUpdate: vi.fn(), onMessage: vi.fn(), onWriteRefused: other })
    const refusal = { code: 'invalid_path', message: 'bad path' }

    FakeSharedWorker.instances[0]?.port.onmessage?.({
      data: { type: 'write-refused', doc: 'w/doc', refusal },
    } as MessageEvent)

    expect(mine.mock.calls).toEqual([[refusal]])
    expect(other).not.toHaveBeenCalled()
  })
})

describe("the worker's word that the daemon refused the session", () => {
  it('reaches the listener for that document, and no other', () => {
    const source = createSharedSseStreamSource(origin('auth-refused'))
    const mine = vi.fn()
    const other = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onAuthRefused: mine })
    source?.subscribe('w/other', { onUpdate: vi.fn(), onMessage: vi.fn(), onAuthRefused: other })

    FakeSharedWorker.instances[0]?.port.onmessage?.({
      data: { type: 'auth-refused', doc: 'w/doc', cause: 'subscribe' },
    } as MessageEvent)

    expect(mine.mock.calls).toEqual([['subscribe']])
    expect(other).not.toHaveBeenCalled()
  })
})

// ADR-0050: a SharedWorker has no `chrome.runtime`, so it cannot reach a
// daemon through the extension — the page holds that stream itself.
describe('a daemon reached through the extension', () => {
  it('gets no shared worker, so the page opens its own stream', () => {
    expect(createSharedSseStreamSource(BRIDGE_DAEMON_BASE_URL)).toBeNull()
    expect(FakeSharedWorker.instances).toHaveLength(0)
  })
})

const postedOfType = (type: string) =>
  (FakeSharedWorker.instances[0]?.port.postMessage.mock.calls ?? []).filter(
    ([request]) => (request as { type: string }).type === type,
  )

// The worker refcounts subscriptions per port, so a document this tab stopped
// announcing is no longer routed here until the tab announces it again.
describe('a document closed and reopened in the same tab', () => {
  it('is announced to the worker again, so its updates are routed back here', () => {
    const source = createSharedSseStreamSource(origin('reopen'))
    const unsubscribe = source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn() })
    unsubscribe?.()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn() })

    expect(postedOfType('subscribe')).toEqual([
      [{ type: 'subscribe', doc: 'w/doc' }],
      [{ type: 'subscribe', doc: 'w/doc' }],
    ])
    expect(postedOfType('unsubscribe')).toHaveLength(1)
  })
})

describe('a tab navigating away', () => {
  it('hands each claimed document back to the worker once', () => {
    const source = createSharedSseStreamSource(origin('pagehide'))
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn() })

    globalThis.dispatchEvent(new Event('pagehide'))
    expect(postedOfType('unsubscribe')).toEqual([[{ type: 'unsubscribe', doc: 'w/doc' }]])

    // A page restored from the back/forward cache can hide again; claims
    // already handed back must not be released a second time.
    globalThis.dispatchEvent(new Event('pagehide'))
    expect(postedOfType('unsubscribe')).toHaveLength(1)
  })
})

describe('a snapshot reply that is not base64', () => {
  it('leaves the waiter for the next reply instead of answering it with nothing', async () => {
    const source = createSharedSseStreamSource(origin('bad-snapshot'))
    const pending = source?.snapshot('w/doc')
    const reply = (snapshot: string) =>
      FakeSharedWorker.instances[0]?.port.onmessage?.({
        data: { type: 'snapshot', doc: 'w/doc', snapshot },
      } as MessageEvent)

    reply('%%% not base64 %%%')
    reply('AQID')

    await expect(pending).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('a snapshot reply with no bytes', () => {
  // The worker's own read of the daemon failed. Resolved, the caller would
  // take it as the document's state — and Loro refuses zero bytes — so it is
  // the same failed read the hub implementation reports by throwing.
  it('rejects every waiter, and the next request is answered', async () => {
    const source = createSharedSseStreamSource(origin('empty-snapshot'))
    const first = source?.snapshot('w/doc')
    const second = source?.snapshot('w/doc')
    const reply = (snapshot: string) =>
      FakeSharedWorker.instances[0]?.port.onmessage?.({
        data: { type: 'snapshot', doc: 'w/doc', snapshot },
      } as MessageEvent)

    reply('')
    await expect(first).rejects.toThrow(/worker could not read the document/)
    await expect(second).rejects.toThrow(/worker could not read the document/)

    const third = source?.snapshot('w/doc')
    reply('AQID')
    await expect(third).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('an event the worker protocol does not describe', () => {
  it('is dropped without reaching a listener or throwing', () => {
    const source = createSharedSseStreamSource(origin('malformed'))
    const onMessage = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage })

    expect(() =>
      FakeSharedWorker.instances[0]?.port.onmessage?.({ data: { nope: 1 } } as MessageEvent),
    ).not.toThrow()
    expect(onMessage).not.toHaveBeenCalled()
  })
})

describe('a SharedWorker the browser refuses to construct', () => {
  it('answers null, so the caller opens its own stream', () => {
    globalThis.SharedWorker = class {
      constructor() {
        throw new Error('blocked by policy')
      }
    } as unknown as typeof SharedWorker

    expect(createSharedSseStreamSource(origin('refused'))).toBeNull()
  })
})

// The worker tells a PORT that arrives mid-retry its writes are failing; a
// second listener in a tab already subscribed has no port of its own to be
// told on, so the tab's source tells it.
describe('a listener joining a document in this tab', () => {
  const tell = (data: Record<string, unknown>) =>
    FakeSharedWorker.instances[0]?.port.onmessage?.({ data } as MessageEvent)

  it('is told the writes are failing while they are', () => {
    const source = createSharedSseStreamSource(origin('joiner-write-state'))
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn() })
    tell({ type: 'write-state', doc: 'w/doc', landed: false })

    const failing = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onWriteState: failing })
    expect(failing.mock.calls).toEqual([[false]])

    tell({ type: 'write-state', doc: 'w/doc', landed: true })
    const later = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onWriteState: later })
    expect(later).not.toHaveBeenCalled()
  })

  it('is not told of a refusal the document has since recovered from', () => {
    const source = createSharedSseStreamSource(origin('joiner-recovered'))
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn() })
    tell({ type: 'auth-refused', doc: 'w/doc', cause: 'subscribe' })
    tell({ type: 'status', doc: 'w/doc', connected: true })

    const refused = vi.fn()
    const states: boolean[] = []
    source?.subscribe('w/doc', {
      onUpdate: vi.fn(),
      onMessage: vi.fn(),
      onAuthRefused: refused,
      onConnectionChange: (connected) => states.push(connected),
    })
    expect({ refused: refused.mock.calls.length, states }).toEqual({ refused: 0, states: [true] })
  })

  it('starts from nothing once the tab has let the document go', () => {
    const source = createSharedSseStreamSource(origin('joiner-released'))
    const off = source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn() })
    tell({ type: 'status', doc: 'w/doc', connected: true })
    off?.()

    const onConnectionChange = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onConnectionChange })
    expect(onConnectionChange).not.toHaveBeenCalled()
  })
})
