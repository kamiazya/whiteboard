/**
 * The failure mode this covers is not a thrown error: a module shared worker
 * whose chunk fails to load constructs FINE and reports through `onerror`
 * afterwards. The try/catch around the constructor cannot see that, so before
 * this the port was a hole — every subscribe posted into it, nothing answered,
 * and the caller never learned it should have opened its own stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  globalThis.SharedWorker = original
})

describe('a shared worker that fails to load', () => {
  it('tells its listeners they are disconnected instead of going quiet', () => {
    const source = createSharedSseStreamSource('http://daemon.test', 't')
    expect(source).not.toBeNull()
    const onConnectionChange = vi.fn()
    source?.subscribe('w/doc', { onUpdate: vi.fn(), onMessage: vi.fn(), onConnectionChange })

    FakeSharedWorker.instances[0]?.fail()

    expect(onConnectionChange).toHaveBeenCalledWith(false)
  })

  it('is evicted, so the next caller gets a fresh worker rather than the dead one', () => {
    createSharedSseStreamSource('http://daemon.test', 't')
    expect(FakeSharedWorker.instances).toHaveLength(1)

    // Without eviction this returns the cached source built on the dead
    // worker, and the hole outlives the failure for the whole session.
    createSharedSseStreamSource('http://daemon.test', 't')
    expect(FakeSharedWorker.instances).toHaveLength(1)

    FakeSharedWorker.instances[0]?.fail()
    createSharedSseStreamSource('http://daemon.test', 't')
    expect(FakeSharedWorker.instances).toHaveLength(2)
  })
})
