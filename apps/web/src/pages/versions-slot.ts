import { getAppLogger } from '../lib/app-logger.js'
import type { VersionsBackend } from '../lib/versions-backend.js'
import type { DocumentPageModel } from './document-page-model.js'

const log = getAppLogger('document-page-versions')

/**
 * The History column's slot, for either keeper: saving a version through the
 * keeper's `VersionsBackend`, and the announcements after it.
 *
 * The request itself belongs to the backend (`lib/versions-backend.ts` for
 * the daemon, the IndexedDB one for the browser); a keeper supplies only
 * which backend and how its listeners learn of a save. The daemon's slot
 * once spoke the versions route itself, a second copy of the request its
 * backend already made.
 *
 * Null backend means nothing is loaded; the column is hidden then, so `save`
 * is never reached through it — it throws rather than guess a store.
 */
export function versionsSlot({
  backend,
  workspaceId,
  documentId,
  announceRefresh,
}: {
  backend: VersionsBackend | null
  workspaceId: string
  /** Undefined until the keeper's listing names the document, which keeps the column hidden. */
  documentId: string | undefined
  announceRefresh: () => void
}): DocumentPageModel['versions'] {
  const addressed = backend === null || documentId === undefined ? null : { backend, documentId }
  return {
    ...(addressed === null
      ? { enabled: false as const }
      : { enabled: true as const, documentId: addressed.documentId }),
    workspaceId,
    save: async (label) => {
      if (addressed === null) throw new Error('saveVersion: no versions backend')
      try {
        const saved = await addressed.backend.save(workspaceId, addressed.documentId, { label })
        return { workspaceId, documentId: addressed.documentId, versionId: saved.id }
      } catch (err) {
        log.warn('save version from the History panel failed', err)
        throw err
      }
    },
    announceRefresh,
  }
}
