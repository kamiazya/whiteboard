import type {
  DocListener,
  SseStreamSource,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { followBrowserWorkspaceWrites, followWorkspaceWrites } from './follow-workspace-writes.js'
import type { WorkspaceBroadcast } from './workspace-broadcast.js'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function follow() {
  let listener: DocListener | undefined
  let subscribedTo: string | undefined
  const unsubscribe = vi.fn()
  const source: SseStreamSource = {
    subscribe(doc, next) {
      subscribedTo = doc
      listener = next
      return unsubscribe
    },
    sendMessage: () => {},
    push: () => {},
    snapshot: async () => null,
  }
  const onMoved = vi.fn()
  const stop = followWorkspaceWrites(source, 'ws-1', onMoved)
  return {
    onMoved,
    stop,
    unsubscribe,
    subscribedTo: () => subscribedTo,
    frame: () => listener?.onUpdate(new Uint8Array([1])),
    connection: (connected: boolean) => listener?.onConnectionChange?.(connected),
  }
}

describe('followWorkspaceWrites', () => {
  it('follows the workspace record, not a document', () => {
    expect(follow().subscribedTo()).toBe('workspace:ws-1')
  })

  it('reads once for a burst of frames, after the burst', () => {
    const f = follow()
    f.frame()
    vi.advanceTimersByTime(60)
    f.frame()
    f.frame()
    vi.advanceTimersByTime(60)
    expect(f.onMoved).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(f.onMoved).toHaveBeenCalledTimes(1)
  })

  it('reads again when a stream that dropped comes back, because frames in between are not replayed', () => {
    const f = follow()
    f.connection(true)
    vi.advanceTimersByTime(1000)
    expect(f.onMoved).not.toHaveBeenCalled()

    f.connection(false)
    f.connection(true)
    vi.advanceTimersByTime(1000)
    expect(f.onMoved).toHaveBeenCalledTimes(1)
  })

  it('does not read for the first connection, which has missed nothing', () => {
    const f = follow()
    f.connection(false)
    f.connection(true)
    vi.advanceTimersByTime(1000)
    expect(f.onMoved).not.toHaveBeenCalled()
  })

  it('cancels a read still waiting out a burst when it is stopped', () => {
    const f = follow()
    f.frame()
    f.stop()
    vi.advanceTimersByTime(1000)
    expect(f.onMoved).not.toHaveBeenCalled()
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
  })
})

function followBrowser() {
  let hear: (message: WorkspaceBroadcast) => void = () => {}
  let listenedTo: string | undefined
  const close = vi.fn()
  const onMoved = vi.fn()
  const stop = followBrowserWorkspaceWrites('ws-1', onMoved, (workspaceId, onMessage) => {
    listenedTo = workspaceId
    hear = onMessage
    return { post: () => {}, close }
  })
  return {
    onMoved,
    stop,
    close,
    listenedTo: () => listenedTo,
    hear: (message: WorkspaceBroadcast) => hear(message),
  }
}

describe('followBrowserWorkspaceWrites', () => {
  it('listens on the workspace it was given', () => {
    expect(followBrowser().listenedTo()).toBe('ws-1')
  })

  it('reads once for a burst of announcements of any kind, after the burst', () => {
    const f = followBrowser()
    f.hear({ type: 'document-created', path: 'a' })
    vi.advanceTimersByTime(60)
    f.hear({ type: 'document-pinned', documentId: 'd' })
    f.hear({ type: 'update', bytes: new Uint8Array([1]) })
    vi.advanceTimersByTime(60)
    expect(f.onMoved).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(f.onMoved).toHaveBeenCalledTimes(1)
  })

  it('cancels a read still waiting out a burst, and closes its end, when stopped', () => {
    const f = followBrowser()
    f.hear({ type: 'document-renamed', documentId: 'd' })
    f.stop()
    vi.advanceTimersByTime(1000)
    expect(f.onMoved).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledTimes(1)
  })
})
