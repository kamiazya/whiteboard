import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import type { ReplicaRecord } from '../lib/replica-record.js'
import {
  createReplicaSaveQueue,
  type ReplicaSaveHealth,
  type ReplicaSaveQueue,
} from '../lib/replica-save-queue.js'
import { listenToWorkspace } from '../lib/workspace-broadcast.js'
import { isWorkspaceRemovedError } from '../lib/workspace-tombstone.js'

/**
 * The replica's save queue (`lib/replica-save-queue.ts`) over React state:
 * whether the last save landed, and the two actions a page takes on it.
 *
 * The unmount FLUSHES rather than cancels — the daemon returning is exactly
 * what unmounts this page, and that moment must not eat the last debounce
 * window of typing.
 */
export function useReplicaSaveQueue(workspaceId: string) {
  const [health, setHealth] = useState<ReplicaSaveHealth>('ok')
  // Keyed by the workspace it was heard for: the page is not remounted when
  // it goes on to show another workspace, and that one's copy is not gone.
  const [copyRemovedFor, setCopyRemovedFor] = useState<string | null>(null)
  const copyRemoved = copyRemovedFor === workspaceId
  const markCopyRemoved = useCallback(() => setCopyRemovedFor(workspaceId), [workspaceId])
  const queue = useMemo(
    () =>
      createReplicaSaveQueue<ReplicaRecord>({
        // A refusal because the copy is gone is not a failed save to retry:
        // nothing written here could be kept, so the page locks instead.
        save: (record) =>
          new BrowserWorkspaceDocs().save(workspaceId, record).then(
            () => undefined,
            (error: unknown) => {
              if (!isWorkspaceRemovedError(error)) throw error
              markCopyRemoved()
            },
          ),
        onHealth: setHealth,
      }),
    [workspaceId, markCopyRemoved],
  )
  useEffect(() => () => queue.flush(), [queue])
  useFlushOnPageLeaving(queue)
  useCopyRemovedLock(workspaceId, queue, copyRemoved, markCopyRemoved)
  return {
    scheduleSave: queue.schedule,
    retrySave: queue.retry,
    saveFailed: health === 'failed',
    copyRemoved,
  }
}

/**
 * The debounce window holds edits already on screen, and a tab that goes away
 * inside it runs no React cleanup. `pagehide` and `visibilitychange` → hidden
 * are the last signals a page reliably gets (Page Lifecycle API), so the
 * pending save goes out on them — the same moment the live document session
 * flushes. Turning visible again is the same event name and must not flush.
 */
function useFlushOnPageLeaving(queue: ReplicaSaveQueue<ReplicaRecord>): void {
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') queue.flush()
    }
    const onPageHide = () => queue.flush()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [queue])
}

/**
 * This browser's copy deleted while the page holds it (`forgetReplicaCopy`,
 * in this tab or another). The page's record is the whole workspace, so a
 * save from it would write everything back; the queue stops on the news
 * rather than on the refusal its next save would meet.
 *
 * The same news drops this tab's replica mark, through the listener the
 * mark itself owns (`markReplica`), so a tab whose page has moved on loses
 * its mark too.
 */
function useCopyRemovedLock(
  workspaceId: string,
  queue: ReplicaSaveQueue<ReplicaRecord>,
  copyRemoved: boolean,
  markCopyRemoved: () => void,
): void {
  useEffect(() => {
    const end = listenToWorkspace(workspaceId, (message) => {
      if (message.type === 'workspace-removed') markCopyRemoved()
    })
    return () => end.close()
  }, [workspaceId, markCopyRemoved])
  useEffect(() => {
    if (copyRemoved) queue.stop()
  }, [copyRemoved, queue])
}
