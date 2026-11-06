/**
 * What deleting a row on the daemon index MEANS, apart from the page that
 * renders it.
 *
 * Pure over rows and the daemon client: no React, no state. They left
 * `DaemonIndexPage.tsx` when naming these steps carried that file past the
 * 800-line budget — which is the budget doing its job, since none of this is
 * rendering.
 */

import type { DuplicateDocumentRequest } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { deleteDocument, duplicateDocument } from '../lib/daemon-api-client.js'

/** One row of the daemon index's document list. */
export interface DocumentRow {
  documentId: string
  path: string
  displayName: string
  updatedAt: string | undefined
  // Absent when the daemon records no kind for the row (pre-kind documents):
  // the list says nothing rather than claiming spatial.
  kind?: DocumentKind
}

/**
 * Duplicate the row at `path`. The daemon addresses a document by id, so a
 * path no row holds has none and nothing is sent.
 */
export function duplicateRow(
  daemonFetch: typeof fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  rows: readonly DocumentRow[],
  path: string,
  request: DuplicateDocumentRequest | undefined,
) {
  const row = rows.find((each) => each.path === path)
  if (row === undefined) return Promise.reject(new Error('No document is open to duplicate.'))
  return duplicateDocument(daemonFetch, daemonBaseUrl, workspaceId, row.documentId, request)
}

/**
 * `deleteEach` over rows named by path, as the delete dialog names them. The
 * daemon addresses a document by id, so a path no row holds has none: it
 * counts as failed without a request.
 */
export async function deleteRows(
  daemonFetch: typeof fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  rows: readonly DocumentRow[],
  paths: readonly string[],
): Promise<{ failed: string[]; lastError: unknown }> {
  const idByPath = new Map(rows.map((row) => [row.path, row.documentId]))
  const pathById = new Map(rows.map((row) => [row.documentId, row.path]))
  const listed = paths.flatMap((path) => idByPath.get(path) ?? [])
  const outcome = await deleteEach(daemonFetch, daemonBaseUrl, workspaceId, listed)
  return {
    failed: [
      ...paths.filter((path) => !idByPath.has(path)),
      ...outcome.failed.flatMap((id) => pathById.get(id) ?? []),
    ],
    lastError: outcome.lastError,
  }
}

/**
 * Delete each document, recording rather than throwing on the ones the daemon
 * refuses.
 *
 * Sequential and failure-tolerant: one document the daemon refuses must not
 * abandon the rest, and the person has to be told how many did not go. The
 * LAST error is kept because it is what the all-failed message reports —
 * daemon-api-client errors are already sanitized, so it is safe to surface.
 */
async function deleteEach(
  daemonFetch: typeof fetch,
  daemonBaseUrl: string,
  workspaceId: string,
  documentIds: readonly string[],
): Promise<{ failed: string[]; lastError: unknown }> {
  const failed: string[] = []
  let lastError: unknown = null
  for (const documentId of documentIds) {
    try {
      await deleteDocument(daemonFetch, daemonBaseUrl, workspaceId, documentId)
    } catch (err) {
      failed.push(documentId)
      lastError = err
    }
  }
  return { failed, lastError }
}
