/**
 * What deleting and duplicating a row on the daemon index MEAN, apart from
 * the page that renders them.
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
 * What duplicating one row asks for: the source's own kind and name, and the
 * names and paths already taken, so the copy can be given a free one.
 *
 * A row the list no longer holds falls back to a spatial document named after
 * its path — the source may have been deleted between the click and the read,
 * and refusing outright would be a worse answer than copying an empty board.
 */
export function duplicateRequest(
  daemonFetch: typeof fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  sourcePath: string,
  rows: readonly DocumentRow[],
) {
  const sourceRow = rows.find((row) => row.path === sourcePath)
  return {
    fetch: daemonFetch,
    daemonBaseUrl,
    workspaceId,
    sourcePath,
    kind: sourceRow?.kind ?? ('spatial' as const),
    displayName: sourceRow?.displayName ?? sourcePath,
    existingPaths: rows.map((row) => row.path),
    existingNames: rows.map((row) => row.displayName),
  }
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
