/**
 * The failure mode this covers is not a thrown error: a module shared worker
 * whose chunk fails to load constructs FINE and reports through `onerror`
 * afterwards. The try/catch around the constructor cannot see that, so before
 * this the port was a hole — every subscribe posted into it, nothing answered,
 * and the caller never learned it should have opened its own stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_DAEMON_BASE_URL } from './bridge-address.js'
import {
  createSharedSseStreamSource,
  sharedStreamFailed,
  subscribeSharedStreamFailure,
} from './sse-shared-stream-source.js'

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
// A worker that failed is remembered against its origin for the module's
// lifetime, and every case fails its workers on the way out, so each run of
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

describe('a shared worker that fails to load', () => {
  it('tells its listeners they are disconnected instead of going quiet', () => {
    const source = createSharedSseStreamSource(origin('disconnected'))
    expect(source).not.toBeNull()
    const onConnectionChange = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onConnectionChange })

    FakeSharedWorker.instances[0]?.fail()

    expect(onConnectionChange).toHaveBeenCalledWith(false)
  })

  it('is remembered, so the next caller for that origin opens its own stream', () => {
    createSharedSseStreamSource(origin('evicted'))
    expect(FakeSharedWorker.instances).toHaveLength(1)
    expect(createSharedSseStreamSource(origin('evicted'))).not.toBeNull()
    expect(FakeSharedWorker.instances).toHaveLength(1)

    FakeSharedWorker.instances[0]?.fail()

    // A missing chunk or a CSP refusal is the same on every attempt, so a
    // fresh worker would fail the same way; `null` is the own-stream path.
    expect(createSharedSseStreamSource(origin('evicted'))).toBeNull()
    expect(FakeSharedWorker.instances).toHaveLength(1)
    expect(sharedStreamFailed(origin('evicted'))).toBe(true)
    expect(sharedStreamFailed(origin('elsewhere'))).toBe(false)
  })

  it('is already forgotten when a listener reconnects on the disconnect it is told', () => {
    let reopened: ReturnType<typeof createSharedSseStreamSource> | 'not asked' = 'not asked'
    const source = createSharedSseStreamSource(origin('reconnect'))
    source?.subscribe('w/doc', {
      onUpdate: vi.fn(),
      onMessage: vi.fn(),
      onConnectionChange: (connected) => {
        if (!connected) reopened = createSharedSseStreamSource(origin('reconnect'))
      },
    })

    FakeSharedWorker.instances[0]?.fail()

    expect(reopened).toBeNull()
  })

  it('rejects a snapshot it was still waiting on', async () => {
    const source = createSharedSseStreamSource(origin('pending-snapshot'))
    const pending = source?.snapshot('workspace:w')

    FakeSharedWorker.instances[0]?.fail()

    await expect(pending).rejects.toThrow()
  })

  it('rejects every later snapshot at once rather than posting into the dead port', async () => {
    const source = createSharedSseStreamSource(origin('later-snapshot'))
    FakeSharedWorker.instances[0]?.fail()

    await expect(source?.snapshot('workspace:w')).rejects.toThrow()
    expect(postedOfType('snapshot-request')).toEqual([])
  })

  it('tells whoever follows the failures, once', () => {
    const told = vi.fn()
    const stop = subscribeSharedStreamFailure(told)
    createSharedSseStreamSource(origin('told'))

    FakeSharedWorker.instances[0]?.fail()
    FakeSharedWorker.instances[0]?.fail()
    stop()

    expect(told).toHaveBeenCalledTimes(1)
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
