import {
  readDocumentKind,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { BrowserBackend } from './browser-backend.js'
import type { BrowserVersionStore } from './browser-version-store.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import type { VersionsBackend } from './versions-backend.js'

/**
 * The browser keeper's answer to the versions seam: rows from the
 * IndexedDB store, restores through the backend that holds the live
 * workspace record — the two halves the daemon keeps in one process, here
 * kept in one page.
 *
 * The `workspaceId` the UI passes is ignored in favour of the browser's
 * own: the top bar spells `"local"` there as a display placeholder (see its
 * `dataMode="local"`), and the store must not file rows under a name that
 * is not a workspace.
 */
export function createBrowserVersionsBackend(deps: {
  readonly store: BrowserVersionStore
  readonly backend: BrowserBackend
}): VersionsBackend {
  return {
    list: (_workspaceId, path) => deps.store.list(getBrowserWorkspaceId(), path),
    save: (_workspaceId, path, { label }) =>
      deps.store.save(getBrowserWorkspaceId(), path, {
        label,
        // The person at this browser. The daemon names its humans by their
        // sync peer; the browser has one person and no peer to name.
        operator: { kind: 'human', peerId: 'browser' },
      }),
    async loadPast(_workspaceId, path, versionId) {
      // The store answers a LoroDoc; the seam answers something to draw. The
      // projection happens here so the seam stays free of CRDT types and a
      // keeper that never held one could still implement it.
      const past = await deps.store.loadPast(getBrowserWorkspaceId(), path, versionId)
      if (past === null) return null
      return readDocumentKind(past) === 'markdown'
        ? { kind: 'markdown', body: readMarkdownBody(past) }
        : { kind: 'spatial', canvas: readSpatialCanvas(past) }
    },
    putThumbnail: (_workspaceId, path, versionId, blob) =>
      deps.store.putThumbnail(getBrowserWorkspaceId(), path, versionId, blob),
    loadThumbnail: (_workspaceId, path, versionId) =>
      deps.store.loadThumbnail(getBrowserWorkspaceId(), path, versionId),
    async restore(_workspaceId, path, versionId) {
      const workspaceId = getBrowserWorkspaceId()
      const past = await deps.store.loadPast(workspaceId, path, versionId)
      if (past === null) throw new Error(`no such version: ${versionId}`)
      const label = (await deps.store.list(workspaceId, path)).find(
        (v) => v.id === versionId,
      )?.label
      await deps.backend.applyRestore(past, label)
      // The merge point, recorded the same way the daemon's operation
      // records it: a restore reconciles a past state onto the live one, so
      // what comes out is a descendant of both, and a merge that leaves no
      // row is a merge nobody can find afterwards. Best effort for the same
      // reason as there — the content has already landed, so a failed row
      // costs the history a point and the document nothing.
      try {
        await deps.store.save(workspaceId, path, { restoredFrom: versionId })
      } catch {
        // See above.
      }
    },
  }
}
