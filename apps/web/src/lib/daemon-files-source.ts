import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocumentEntry } from '../components/workspace-files/document-entry.js'
import {
  type WorkspaceFilesSource,
  WorkspaceMissingError,
} from '../components/workspace-files/files-source.js'
import {
  createDocument,
  DaemonApiError,
  getDocumentOkfV1,
  getDocumentSnapshot,
  getWorkspaceNames,
  listDocuments,
  renameDocumentPath,
} from './daemon-api-client.js'

/**
 * `WorkspaceFilesSource` over the daemon's HTTP API — the same five client
 * calls `WorkspaceFilesPanel` used to make itself, moved behind the seam so
 * the panel stops being daemon-only.
 *
 * The one piece of translation is the 404: the panel's not-found state is
 * mode-independent, so the daemon's `DaemonApiError(404)` becomes the seam's
 * `WorkspaceMissingError` here rather than leaking into the panel.
 */
export function createDaemonFilesSource(
  daemonFetch: typeof globalThis.fetch,
  daemonBaseUrl: string,
  workspaceId: string,
): WorkspaceFilesSource {
  return {
    async listDocuments(): Promise<readonly WorkspaceDocumentEntry[]> {
      try {
        // Names ride alongside the list for their pinned[] — pin order is
        // workspace state the /documents response does not carry. A failed
        // names fetch degrades to "nothing pinned", never to a failed list,
        // matching what the grid page did.
        const [res, names] = await Promise.all([
          listDocuments(daemonFetch, daemonBaseUrl, workspaceId),
          getWorkspaceNames(daemonFetch, daemonBaseUrl, workspaceId).catch(() => null),
        ])
        const pinIndex = new Map((names?.pinned ?? []).map((path, i) => [path, i]))
        return res.documents.map((entry) => ({
          // An older daemon omits the id; the path stands in, as it does
          // everywhere else that reads this list.
          documentId: entry.id ?? entry.path,
          path: entry.path,
          ...(entry.displayName === undefined ? {} : { name: entry.displayName }),
          ...(entry.kind === undefined ? {} : { kind: entry.kind }),
          ...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt }),
          ...(pinIndex.has(entry.path) ? { pinOrder: pinIndex.get(entry.path) as number } : {}),
        }))
      } catch (err) {
        if (err instanceof DaemonApiError && err.status === 404) {
          throw new WorkspaceMissingError(workspaceId)
        }
        throw err
      }
    },

    async createDocument(path: string, kind: DocumentKind): Promise<void> {
      await createDocument(daemonFetch, daemonBaseUrl, workspaceId, path, kind)
    },

    async renameDocumentPath(path: string, newPath: string): Promise<void> {
      await renameDocumentPath(daemonFetch, daemonBaseUrl, workspaceId, path, newPath)
    },

    async loadMarkdown(entry: WorkspaceDocumentEntry): Promise<string> {
      return (await getDocumentOkfV1(daemonFetch, daemonBaseUrl, workspaceId, entry.documentId))
        .markdown
    },

    loadSpatialSnapshot(entry: WorkspaceDocumentEntry): Promise<Uint8Array> {
      return getDocumentSnapshot(daemonFetch, daemonBaseUrl, workspaceId, entry.path)
    },
  }
}
