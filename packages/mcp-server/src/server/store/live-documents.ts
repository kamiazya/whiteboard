import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import type { LiveDocuments } from '@kamiazya/whiteboard-server-core'
import { evictDoc } from './doc-cache.js'
import {
  ConflictError,
  deleteDocument,
  documentExists,
  getDoc,
  getDocumentKind,
  listDocuments,
  renameDocumentPath,
  saveDocument,
} from './document-store.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

/**
 * The daemon's `LiveDocuments` seam: one bundle over the document store, the
 * doc cache and the workspace lock, so an operation in server-core can reach
 * them without any adapter importing a mechanic (ADR-0018).
 *
 * The only translation here is the error contract: the store refuses a taken
 * path with its own `ConflictError`, and the seam promises ports'
 * `DocumentPathTakenError` — the one class server-core can name.
 */
export function liveDocuments(): LiveDocuments {
  return {
    get: getDoc,
    async save(workspaceId, path, doc, options) {
      try {
        await saveDocument(workspaceId, path, doc, options)
      } catch (err) {
        if (err instanceof ConflictError) throw new DocumentPathTakenError(workspaceId, path)
        throw err
      }
    },
    exists: documentExists,
    kind: getDocumentKind,
    list: listDocuments,
    async rename(workspaceId, oldPath, newPath) {
      await renameDocumentPath(workspaceId, oldPath, newPath)
    },
    async delete(workspaceId, path) {
      await deleteDocument(workspaceId, path)
    },
    evict: evictDoc,
    withWriteLock: withWorkspaceWriteLock,
  }
}
