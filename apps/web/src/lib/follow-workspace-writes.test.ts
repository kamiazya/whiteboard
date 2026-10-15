import type {
  DocListener,
  SseStreamSource,
} from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { createWorkspaceDocumentAtPath } from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  followBrowserWorkspaceWrites,
  followRecordWrites,
  followWorkspaceWrites,
} from './follow-workspace-writes.js'
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
  const onRemoved = vi.fn()
  const stop = followBrowserWorkspaceWrites(
    'ws-1',
    { onMoved, onRemoved },
    (workspaceId, onMessage) => {
      listenedTo = workspaceId
      hear = onMessage
      return { post: () => {}, close }
    },
  )
  return {
    onMoved,
    onRemoved,
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

  it('reports the workspace leaving this browser at once, and reads nothing under it', () => {
    const f = followBrowser()
    f.hear({ type: 'document-created', path: 'a' })
    f.hear({ type: 'workspace-removed' })
    expect(f.onRemoved).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(f.onMoved).not.toHaveBeenCalled()
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

describe('followRecordWrites', () => {
  const MAIN = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const PLAN = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

  /** A record that follows a peer, and the peer's next write imported into it. */
  function followedRecord() {
    const peer = new LoroDoc()
    createWorkspaceDocumentAtPath(peer, { path: 'main', documentId: MAIN, kind: 'spatial' })
    peer.commit()
    const record = new LoroDoc()
    record.import(peer.export({ mode: 'snapshot' }))
    return {
      record,
      peerCreatesPlan() {
        const from = peer.oplogVersion()
        createWorkspaceDocumentAtPath(peer, { path: 'plan', documentId: PLAN, kind: 'markdown' })
        peer.commit()
        record.import(peer.export({ mode: 'update', from }))
      },
    }
  }

  it('answers the shape it saw last, so a replacing record is not taken as the baseline', () => {
    const { record } = followedRecord()
    const first = followRecordWrites(record, null, vi.fn())
    const seen = first.seen()
    first.stop()
    const onMoved = vi.fn()

    followRecordWrites(record, seen, onMoved)
    vi.runOnlyPendingTimers()

    expect(seen).not.toBeNull()
    expect(onMoved).not.toHaveBeenCalled()
  })

  it('cancels a compare still waiting out a burst when it is stopped', async () => {
    const { record, peerCreatesPlan } = followedRecord()
    const onMoved = vi.fn()
    const follow = followRecordWrites(record, null, onMoved)
    onMoved.mockClear()

    peerCreatesPlan()
    await Promise.resolve()
    follow.stop()
    vi.runOnlyPendingTimers()

    expect(onMoved).not.toHaveBeenCalled()
  })
})
