import type { SseStreamSource } from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { SseStreamHub } from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { useEffect } from 'react'
import { followWorkspaceWrites } from '../lib/follow-workspace-writes.js'
import { createSharedSseStreamSource } from '../lib/sse-shared-stream-source.js'

interface Connection {
  readonly daemonFetch: typeof globalThis.fetch
  readonly daemonBaseUrl: string
  readonly token: string | undefined
  /** What a parent substitutes for the stream the page would open itself. */
  readonly streamSource?: SseStreamSource
}

/** The stream to follow through, and how to let go of it: only a hub opened here is closed here. */
function openStream({ daemonFetch, daemonBaseUrl, token, streamSource }: Connection): {
  readonly source: SseStreamSource
  readonly close: () => void
} {
  if (streamSource !== undefined) return { source: streamSource, close: () => {} }
  const shared = createSharedSseStreamSource(daemonBaseUrl, token)
  if (shared !== null) return { source: shared, close: () => {} }
  const hub = new SseStreamHub({ fetch: daemonFetch, baseUrl: daemonBaseUrl })
  return { source: hub, close: () => hub.close() }
}

/**
 * Reads the workspace's list again when something other than this page wrote
 * to it. The stream is the one the document page syncs through: the
 * SharedWorker's, shared across tabs, where there is one, and otherwise a hub
 * of this page's own, which is closed with it.
 *
 * `reload` is told when its answer has gone stale, which is when the page has
 * moved to another workspace or gone away.
 */
export function useFollowWorkspaceWrites(
  connection: Connection,
  workspaceId: string | null,
  reload: (workspaceId: string, isStale: () => boolean) => Promise<void>,
): void {
  const { daemonFetch, daemonBaseUrl, token, streamSource } = connection
  useEffect(() => {
    if (workspaceId === null) return
    let stale = false
    const { source, close } = openStream({ daemonFetch, daemonBaseUrl, token, streamSource })
    const stop = followWorkspaceWrites(source, workspaceId, () => {
      void reload(workspaceId, () => stale)
    })
    return () => {
      stale = true
      stop()
      close()
    }
  }, [workspaceId, reload, daemonFetch, daemonBaseUrl, token, streamSource])
}
