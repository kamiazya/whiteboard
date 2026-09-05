import { attachVersionThumbnail } from './version-thumbnail.js'
import type { VersionsBackend } from './versions-backend.js'

/**
 * The save body both document pages hand to `useVersionSaveFlow`, built from
 * the four moves that only differ per keeper. The shape it pins:
 *
 * - The picture is captured BEFORE the save — started synchronously, so it
 *   binds to the state the save is about to mark. Awaiting the save first
 *   meant an edit made during it was drawn onto the older point: a picture
 *   of content that version does not contain.
 * - The announce closure runs only after `useVersionSaveFlow`'s guard has
 *   confirmed the saved document is still on screen. Its beats are
 *   synchronous; the thumbnail rides along unawaited, because the bookmark
 *   has landed and its picture arriving late must not hold up the row.
 * - Once the picture lands, `announceRefresh` fires a SECOND time: the row
 *   landed before its picture did, so the list the first beat refreshed
 *   holds a row that says it has none. A failed attach reports through
 *   `onThumbnailFailed` and deliberately does not re-announce.
 */
export function buildVersionSaveBody(deps: {
  /** Starts the pre-save capture; the promise rides to the keeper later. */
  capture: () => Promise<Blob | null>
  /** Performs the save and answers where the new version lives. */
  save: (label: string) => Promise<{ workspaceId: string; path: string; versionId: string }>
  backend: Pick<VersionsBackend, 'putThumbnail'>
  /** The beat that refreshes this page's version list; fired after the save and again after the picture lands. */
  announceRefresh: () => void
  /** A beat fired exactly once after the save (e.g. the daemon page's identity event). */
  announceOnce?: () => void
  onThumbnailFailed: () => void
}): (label: string) => Promise<() => void> {
  return async (label) => {
    const picture = deps.capture()
    const saved = await deps.save(label)
    return () => {
      deps.announceRefresh()
      deps.announceOnce?.()
      void attachVersionThumbnail({
        backend: deps.backend,
        workspaceId: saved.workspaceId,
        path: saved.path,
        versionId: saved.versionId,
        getBlob: () => picture,
      }).then((outcome) => {
        if (outcome === 'failed') {
          deps.onThumbnailFailed()
          return
        }
        deps.announceRefresh()
      })
    }
  }
}
