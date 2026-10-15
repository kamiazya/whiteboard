/**
 * The failure mode this covers is not a thrown error: a module shared worker
 * whose chunk fails to load constructs FINE and reports through `onerror`
 * afterwards. The try/catch around the constructor cannot see that, so before
 * this the port was a hole — every subscribe posted into it, nothing answered,
 * and the caller never learned it should have opened its own stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL } from './bridge-address.js'
import { createSharedSseStreamSource } from './sse-shared-stream-source.js'

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
afterEach(() => {
  // Sources are cached per origin for the module's lifetime; failing every
  // worker a case made evicts them, so a repeated run starts from nothing.
  for (const worker of FakeSharedWorker.instances) worker.fail()
  globalThis.SharedWorker = original
})

describe('a shared worker that fails to load', () => {
  it('tells its listeners they are disconnected instead of going quiet', () => {
    const source = createSharedSseStreamSource('http://daemon.test')
    expect(source).not.toBeNull()
    const onConnectionChange = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onConnectionChange })

    FakeSharedWorker.instances[0]?.fail()

    expect(onConnectionChange).toHaveBeenCalledWith(false)
  })

  it('is evicted, so the next caller gets a fresh worker rather than the dead one', () => {
    createSharedSseStreamSource('http://daemon.test')
    expect(FakeSharedWorker.instances).toHaveLength(1)

    // Without eviction this returns the cached source built on the dead
    // worker, and the hole outlives the failure for the whole session.
    createSharedSseStreamSource('http://daemon.test')
    expect(FakeSharedWorker.instances).toHaveLength(1)

    FakeSharedWorker.instances[0]?.fail()
    createSharedSseStreamSource('http://daemon.test')
    expect(FakeSharedWorker.instances).toHaveLength(2)
  })
})

describe("the worker's word on a document's writes", () => {
  // A tab's push returns before the keeper answers, so this event is the only
  // way a page learns its edit did not land — and that it later did.
  it('reaches the listener for that document, and no other', () => {
    const source = createSharedSseStreamSource('http://write-state.test')
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
    const source = createSharedSseStreamSource('http://write-refused.test')
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
    const source = createSharedSseStreamSource('http://auth-refused.test')
    const mine = vi.fn()
    const other = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onAuthRefused: mine })
    source?.subscribe('w/other', { onUpdate: vi.fn(), onMessage: vi.fn(), onAuthRefused: other })

    FakeSharedWorker.instances[0]?.port.onmessage?.({
      data: { type: 'auth-refused', doc: 'w/doc' },
    } as MessageEvent)

    expect(mine).toHaveBeenCalledTimes(1)
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
    const source = createSharedSseStreamSource('http://reopen.test')
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
    const source = createSharedSseStreamSource('http://pagehide.test')
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
    const source = createSharedSseStreamSource('http://bad-snapshot.test')
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
    const source = createSharedSseStreamSource('http://empty-snapshot.test')
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
    const source = createSharedSseStreamSource('http://malformed.test')
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

    expect(createSharedSseStreamSource('http://refused.test')).toBeNull()
  })
})
