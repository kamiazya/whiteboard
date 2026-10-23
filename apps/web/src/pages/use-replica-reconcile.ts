import { useEffect } from 'react'
import { scheduleReplicaPush, scheduleReplicaRefresh } from '../lib/replica-refresh.js'

/**
 * ADR-0023's replica reconciliation, both directions, at the moment this
 * browser is working on a daemon workspace. PUSH first (decision 3's
 * return half — offline edits ship as ordinary ops; a clean replica costs
 * one IndexedDB read and no network), THEN the pull refresh, so a
 * merge-back cannot read as an offline edit vanishing between the two.
 * Both modules dedupe internally, so the effect can fire on every resolve.
 */
export function useReplicaReconcile({
  daemonFetch,
  daemonBaseUrl,
  workspaceId,
  serverMode,
}: {
  readonly daemonFetch: typeof globalThis.fetch
  readonly daemonBaseUrl: string
  readonly workspaceId: string | null
  readonly serverMode: boolean
}): void {
  useEffect(() => {
    if (workspaceId === null || serverMode) return
    const cancelPush = scheduleReplicaPush({
      fetch: daemonFetch,
      daemonBaseUrl,
      workspaceId,
    })
    const cancelRefresh = scheduleReplicaRefresh({
      fetch: daemonFetch,
      daemonBaseUrl,
      workspaceId,
    })
    // Both are scheduled onto an idle callback or a 1.5s timer, so without
    // this they outlive the page that asked — and fire against a fetch, a
    // daemon address and a workspace that have all moved on. Cancelling is
    // free where the run has already begun (it is left alone to finish) and
    // releases the dedupe where it has not, so the next resolve tries again.
    return () => {
      cancelPush()
      cancelRefresh()
    }
  }, [daemonFetch, daemonBaseUrl, workspaceId, serverMode])
}
