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
  path,
  announceRefresh,
  announceOnce,
}: {
  backend: VersionsBackend | null
  workspaceId: string
  path: string
  announceRefresh: () => void
  announceOnce?: () => void
}): DocumentPageModel['versions'] {
  return {
    enabled: backend !== null,
    workspaceId,
    path,
    save: async (label) => {
      if (backend === null) throw new Error('saveVersion: no versions backend')
      try {
        const saved = await backend.save(workspaceId, path, { label })
        return { workspaceId, path, versionId: saved.id }
      } catch (err) {
        log.warn('save version from the History panel failed', err)
        throw err
      }
    },
    announceRefresh,
    ...(announceOnce === undefined ? {} : { announceOnce }),
  }
}
