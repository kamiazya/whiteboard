/**
 * What deleting a row on the daemon index MEANS, apart from the page that
 * renders it.
 *
 * Pure over rows and the daemon client: no React, no state. They left
 * `DaemonIndexPage.tsx` when naming these steps carried that file past the
 * 800-line budget — which is the budget doing its job, since none of this is
 * rendering.
 */
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { deleteDocument } from '../lib/daemon-api-client.js'

/** One row of the daemon index's document list. */
export interface DocumentRow {
  path: string
  displayName: string
  updatedAt: string | undefined
  // Absent when the daemon records no kind for the row (pre-kind documents):
  // the list says nothing rather than claiming spatial.
  kind?: DocumentKind
}

/**
 * Delete each path, recording rather than throwing on the ones the daemon
 * refuses.
 *
 * Sequential and failure-tolerant: one path the daemon refuses must not
 * abandon the rest, and the person has to be told how many did not go. The
 * LAST error is kept because it is what the all-failed message reports —
 * daemon-api-client errors are already sanitized, so it is safe to surface.
 */
export async function deleteEach(
  daemonFetch: typeof fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  paths: readonly string[],
): Promise<{ failed: string[]; lastError: unknown }> {
  const failed: string[] = []
  let lastError: unknown = null
  for (const path of paths) {
    try {
      await deleteDocument(daemonFetch, daemonBaseUrl, workspaceId, path)
    } catch (err) {
      failed.push(path)
      lastError = err
    }
  }
  return { failed, lastError }
}
