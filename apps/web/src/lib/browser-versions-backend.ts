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
 * is not a workspace. No thumbnails: the browser renders none, and the
 * seam says so by leaving `putThumbnail` out.
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
    async restore(_workspaceId, path, versionId) {
      const workspaceId = getBrowserWorkspaceId()
      const past = await deps.store.loadPast(workspaceId, path, versionId)
      if (past === null) throw new Error(`no such version: ${versionId}`)
      const label = (await deps.store.list(workspaceId, path)).find(
        (v) => v.id === versionId,
      )?.label
      await deps.backend.applyRestore(past, label)
    },
  }
}
