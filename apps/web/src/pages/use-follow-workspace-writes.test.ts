import type {
  DocListener,
  SseStreamSource,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { SseStreamHub } from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useFollowWorkspaceWrites } from './use-follow-workspace-writes.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A stream source that records who is subscribed, so a test can push frames and see unsubscribes. */
function fakeSource() {
  const listeners = new Map<string, DocListener>()
  const unsubscribed: string[] = []
  const source: SseStreamSource = {
    subscribe(doc, next) {
      listeners.set(doc, next)
      return () => {
        listeners.delete(doc)
        unsubscribed.push(doc)
      }
    },
    sendMessage: () => {},
    push: () => {},
    snapshot: async () => null,
  }
  return { source, listeners, unsubscribed }
}

const daemonFetch = (() => Promise.reject(new Error('no network'))) as typeof fetch
const daemonBaseUrl = 'http://127.0.0.1:1'

type Reload = (workspaceId: string, isStale: () => boolean) => Promise<void>

describe('useFollowWorkspaceWrites', () => {
  it('a reload begun for one workspace reads stale once the page follows another', () => {
    vi.useFakeTimers()
    const { source, listeners, unsubscribed } = fakeSource()
    const reload = vi.fn<Reload>(async () => {})
    const hook = renderHook(
      ({ ws }: { ws: string | null }) =>
        useFollowWorkspaceWrites({ daemonFetch, daemonBaseUrl, streamSource: source }, ws, reload),
      { initialProps: { ws: 'ws-1' as string | null } },
    )

    listeners.get('workspace:ws-1')?.onUpdate(new Uint8Array([1]))
    vi.runOnlyPendingTimers()
    expect(reload).toHaveBeenCalledTimes(1)
    const [reloadedFor, isStale] = reload.mock.calls[0] ?? []
    expect(reloadedFor).toBe('ws-1')
    expect(isStale?.()).toBe(false)

    hook.rerender({ ws: 'ws-2' })

    expect(isStale?.()).toBe(true)
    expect(unsubscribed).toEqual(['workspace:ws-1'])
    expect([...listeners.keys()]).toEqual(['workspace:ws-2'])
  })

  it('no workspace subscribes to nothing', () => {
    const { source, listeners } = fakeSource()
    renderHook(() =>
      useFollowWorkspaceWrites(
        { daemonFetch, daemonBaseUrl, streamSource: source },
        null,
        async () => {},
      ),
    )
    expect(listeners.size).toBe(0)
  })

  it('unmounting lets go of the subscription', () => {
    const { source, listeners, unsubscribed } = fakeSource()
    const hook = renderHook(() =>
      useFollowWorkspaceWrites(
        { daemonFetch, daemonBaseUrl, streamSource: source },
        'ws-1',
        async () => {},
      ),
    )
    expect(listeners.size).toBe(1)
    hook.unmount()
    expect(unsubscribed).toEqual(['workspace:ws-1'])
    expect(listeners.size).toBe(0)
  })

  it('a hub the hook opened itself is closed on unmount', () => {
    // jsdom has no SharedWorker, so with no source passed in the hook opens its own hub.
    const close = vi.spyOn(SseStreamHub.prototype, 'close')
    vi.spyOn(SseStreamHub.prototype, 'subscribe').mockReturnValue(() => {})
    const hook = renderHook(() =>
      useFollowWorkspaceWrites({ daemonFetch, daemonBaseUrl }, 'ws-1', async () => {}),
    )
    expect(close).not.toHaveBeenCalled()
    hook.unmount()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

/** A SharedWorker that constructs fine and fails to load afterwards, the way a missing chunk does. */
class FailingSharedWorker {
  static instances: FailingSharedWorker[] = []
  onerror: ((event: unknown) => void) | null = null
  readonly port = { postMessage: vi.fn(), start: vi.fn(), onmessage: null }
  constructor() {
    FailingSharedWorker.instances.push(this)
  }
  fail() {
    this.onerror?.({ message: 'chunk failed to load' })
  }
}

describe('useFollowWorkspaceWrites when the shared worker fails to load', () => {
  const originalSharedWorker = globalThis.SharedWorker
  afterEach(() => {
    globalThis.SharedWorker = originalSharedWorker
  })

  it('follows the workspace again through a stream of its own', () => {
    FailingSharedWorker.instances = []
    globalThis.SharedWorker = FailingSharedWorker as unknown as typeof SharedWorker
    const subscribe = vi.spyOn(SseStreamHub.prototype, 'subscribe').mockReturnValue(() => {})
    // Held stable, as the page holds it, so nothing but the failure can
    // re-run the follow.
    const reload = vi.fn<Reload>(async () => {})
    renderHook(() =>
      useFollowWorkspaceWrites(
        { daemonFetch, daemonBaseUrl: 'http://follow-worker-fails.test' },
        'ws-1',
        reload,
      ),
    )
    expect(FailingSharedWorker.instances).toHaveLength(1)
    expect(subscribe).not.toHaveBeenCalled()

    act(() => FailingSharedWorker.instances[0]?.fail())

    expect(subscribe.mock.calls.map(([doc]) => doc)).toEqual(['workspace:ws-1'])
    expect(FailingSharedWorker.instances).toHaveLength(1)
  })
})
