import { DocumentPathTakenError } from '@kamiazya/whiteboard-ports'
import type { LiveDocuments, WorkspaceDocuments } from '@kamiazya/whiteboard-server-core'
import { evictDoc, evictWorkspaceDocs } from './doc-cache.js'
import {
  ConflictError,
  deleteDocument,
  documentExists,
  evictWorkspaceDocCache,
  getDoc,
  getDocumentKind,
  getWorkspaceDoc,
  listDocuments,
  onWorkspaceDocUpdated,
  renameDocumentPath,
  saveDocument,
  saveWorkspaceDoc,
  workspaceExists,
} from './document-store.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'
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
export function liveDocuments(scope: StoreScope = globalStoreScope): LiveDocuments {
  return {
    get: (workspaceId, path) => getDoc(workspaceId, path, scope),
    async save(workspaceId, path, doc, options) {
      try {
        await saveDocument(workspaceId, path, doc, options, scope)
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
    evict: (workspaceId, path) => evictDoc(workspaceId, path, scope),
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
    get: (workspaceId) => getWorkspaceDoc(workspaceId, scope),
    async save(workspaceId, doc) {
      // saveWorkspaceDoc answers the update bytes it fanned out; the seam
      // promises only persistence, so the value is deliberately dropped.
      await saveWorkspaceDoc(workspaceId, doc, scope)
    },
    evictProjections: (workspaceId) => evictWorkspaceDocs(workspaceId, scope),
    evict: (workspaceId) => evictWorkspaceDocCache(workspaceId, scope),
    onUpdated: onWorkspaceDocUpdated,
  }
}
