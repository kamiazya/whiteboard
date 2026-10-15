import type { SseStreamSource } from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { SseStreamHub } from '@kamiazya/whiteboard-daemon-client/sse-stream-hub'
import { useEffect, useRef } from 'react'
import {
  followBrowserWorkspaceWrites,
  followRecordWrites,
  followWorkspaceWrites,
  type WorkspaceRecord,
} from '../lib/follow-workspace-writes.js'
import { createSharedSseStreamSource } from '../lib/sse-shared-stream-source.js'
import { useSharedStreamFailed } from './use-shared-stream-failed.js'

interface Connection {
  readonly daemonFetch: typeof globalThis.fetch
  readonly daemonBaseUrl: string
  /** What a parent substitutes for the stream the page would open itself. */
  readonly streamSource?: SseStreamSource
}

/** The stream to follow through, and how to let go of it: only a hub opened here is closed here. */
function openStream({ daemonFetch, daemonBaseUrl, streamSource }: Connection): {
  readonly source: SseStreamSource
  readonly close: () => void
} {
  if (streamSource !== undefined) return { source: streamSource, close: () => {} }
  const shared = createSharedSseStreamSource(daemonBaseUrl)
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
  const { daemonFetch, daemonBaseUrl, streamSource } = connection
  // A worker that failed to load has dropped every subscription it held, so
  // the follow starts again, and `openStream` then opens a hub of its own.
  const sharedStreamFailed = useSharedStreamFailed(daemonBaseUrl)
  useEffect(() => {
    if (workspaceId === null) return
    let stale = false
    const { source, close } = openStream({ daemonFetch, daemonBaseUrl, streamSource })
    const stop = followWorkspaceWrites(source, workspaceId, () => {
      void reload(workspaceId, () => stale)
    })
    return () => {
      stale = true
      stop()
      close()
    }
  }, [workspaceId, reload, daemonFetch, daemonBaseUrl, streamSource, sharedStreamFailed])
}

/**
 * The browser keeper's follow, for a list that re-reads on a revision count:
 * bumps it when another end of the workspace's channel — another tab, or a
 * write this tab's index announced — says the record changed. Every other
 * tab writes to this record too, and a list that only followed its own
 * writes never showed another tab's create or rename. `onRemoved` is told
 * once the workspace has left this browser.
 */
export function useFollowOtherTabs(
  workspaceId: string | null,
  setRevision: (next: (revision: number) => number) => void,
  onRemoved: (workspaceId: string) => void,
): void {
  useEffect(() => {
    if (workspaceId === null) return
    return followBrowserWorkspaceWrites(workspaceId, {
      onMoved: () => setRevision((n) => n + 1),
      onRemoved: () => onRemoved(workspaceId),
    })
  }, [workspaceId, setRevision, onRemoved])
}

/**
 * Keeps the page's document list following the workspace record it syncs.
 *
 * A document created, renamed, moved, deleted or edited elsewhere — an
 * agent's write, another tab's, another member's — arrives as an import into
 * that record and nowhere else; the list every link, reference and embed on
 * the page resolves against is a separate read, so without this it stays as
 * it was at open. A record replaced by a reconnect snapshot is compared
 * against the one before it, since what it carries may have been missed
 * while disconnected.
 *
 * Takes the session's body binding because its `doc` IS the live record, and
 * a new binding is exactly a snapshot that replaced it.
 */
export function useListFollowsRecord(
  binding: { readonly doc: WorkspaceRecord } | null,
  refresh: () => void,
): void {
  const record = binding?.doc ?? null
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const seenRef = useRef<string | null>(null)
  useEffect(() => {
    if (record === null) return
    const follow = followRecordWrites(record, seenRef.current, () => refreshRef.current())
    return () => {
      seenRef.current = follow.seen()
      follow.stop()
    }
  }, [record])
}
