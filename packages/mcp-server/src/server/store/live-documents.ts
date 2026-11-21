import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import type { LiveDocuments, WorkspaceDocuments } from '@kamiazya/whiteboard-server-core'
import {
  ConflictError,
  deleteDocument,
  documentExists,
  evictWorkspaceDocCache,
  getDocumentKind,
  listDocuments,
  onWorkspaceDocUpdated,
  renameDocumentPath,
  saveDocumentBytes,
  workspaceExists,
} from './document-store.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
import { withWorkspaceRecord } from './workspace-doc-cache.js'
import { withWorkspaceWriteLock } from './workspace-lock.js'

/**
 * The daemon's `LiveDocuments` seam: one bundle over the document store and the
 * workspace lock, so an operation in server-core can reach
 * them without any adapter importing a mechanic (ADR-0018).
 *
 * The only translation here is the error contract: the store refuses a taken
 * path with its own `ConflictError`, and the seam promises ports'
 * `DocumentPathTakenError` — the one class server-core can name.
 */
export function liveDocuments(scope: StoreScope = globalStoreScope): LiveDocuments {
  return {
    async create(workspaceId, path, snapshot, options) {
      try {
        await saveDocumentBytes(workspaceId, path, snapshot, options, scope)
      } catch (err) {
        if (err instanceof ConflictError) throw new DocumentPathTakenError(workspaceId, path)
        throw err
      }
    },
    exists: (workspaceId, path) => documentExists(workspaceId, path, scope),
    kind: (workspaceId, path) => getDocumentKind(workspaceId, path, scope),
    list: (workspaceId) => listDocuments(workspaceId, scope),
    async rename(workspaceId, oldPath, newPath) {
      await renameDocumentPath(workspaceId, oldPath, newPath, scope)
    },
    async delete(workspaceId, path) {
      await deleteDocument(workspaceId, path, scope)
    },
    withWriteLock: withWorkspaceWriteLock,
  }
}

/**
 * The workspace-granularity half of the same seam, in the same bundle file
 * (one mechanic bundle per composition, not one per axis). `save`'s
 * subscriber fan-out lives inside `saveWorkspaceDoc`, which is what lets
 * the seam promise callers never broadcast separately.
 */
export function workspaceDocuments(scope: StoreScope = globalStoreScope): WorkspaceDocuments {
  return {
    exists: (workspaceId) => workspaceExists(workspaceId, scope),
    withRecord: (workspaceId, fn) => withWorkspaceRecord(workspaceId, scope, fn),
    evict: (workspaceId) => evictWorkspaceDocCache(workspaceId, scope),
    onUpdated: onWorkspaceDocUpdated,
  }
}
