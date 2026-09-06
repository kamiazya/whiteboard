import { readBranchesFromRecord } from '@kamiazya/whiteboard-history'
import { readMarkdownBody, readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import type { BrowserVersionStore } from './browser-version-store.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import type { VersionsBackend } from './versions-backend.js'

/**
 * The live workspace record, as much of it as versions need: read one thing
 * off it, and reconcile a past state onto it.
 *
 * A SEAM rather than `BrowserBackend` itself, because the two kinds of
 * document this keeper holds reach the record by different routes and only
 * one of them has a backend. A spatial canvas has `BrowserBackend`, which
 * satisfies this structurally; a markdown note deliberately has none — the
 * spatial sync layer would clobber the body `useMarkdownDocument` writes —
 * and that hook supplies its own (`MarkdownRecordSeam`).
 *
 * Naming the backend here is what made a note's history unreachable: the
 * rows were always there, keyed on the same record and written by the same
 * checkpoint scheduler, and the only thing missing was a way to read and
 * restore one.
 */
export interface VersionsRecordSeam {
  readonly readRecord: <T>(read: (doc: LoroDoc, documentId: string) => T) => T | null
  readonly applyRestore: (past: LoroDoc, label?: string) => Promise<void>
}

/**
 * The browser keeper's answer to the versions seam: rows from the
 * IndexedDB store, restores through whichever seam holds the live
 * workspace record — the two halves the daemon keeps in one process, here
 * kept in one page. Which route reaches that record is the seam's
 * business, not this module's.
 *
 * The `workspaceId` the UI passes is ignored in favour of the browser's
 * own: the top bar spells `"local"` there as a display placeholder (see its
 * `dataMode="local"`), and the store must not file rows under a name that
 * is not a workspace.
 */
export function createBrowserVersionsBackend(deps: {
  readonly store: BrowserVersionStore
  readonly record: VersionsRecordSeam
  /**
   * What `loadPast` should read a past state AS.
   *
   * Supplied rather than read off the state itself, because it is not in
   * there to read. A workspace-tree document keeps its kind in the NODE's
   * meta, and `projectWorkspaceDocument` carries content only — measured on
   * a seeded markdown note, `readDocumentKind` answers `undefined` for both
   * the projection and the live containers while the body reads back
   * `'# first'`. Asking the state was therefore always answering "not
   * markdown", which a canvas survives by being the fallback and a note does
   * not: it drew an empty CanvasViewer where its prose should be.
   */
  readonly kind: DocumentKind
}): VersionsBackend {
  return {
    list: (_workspaceId, path) => deps.store.list(getBrowserWorkspaceId(), path),
    save(_workspaceId, path, { label }) {
      // WHICH variation this lands on is the keeper's to resolve — the seam
      // carries a label and nothing else, and the daemon's route reads HEAD
      // the same way before writing its row. Without this a browser document
      // with variations files every manual save on the default lane while
      // its automatic checkpoints lane correctly, which reads as a history
      // that lost track of where the work happened.
      //
      // A record that cannot answer falls back to the store's own default,
      // exactly as the daemon's route does.
      const head =
        deps.record.readRecord((doc, documentId) => readBranchesFromRecord(doc, documentId).head) ??
        null
      return deps.store.save(getBrowserWorkspaceId(), path, {
        label,
        ...(head === null || head === '' ? {} : { branchName: head }),
        // The person at this browser. The daemon names its humans by their
        // sync peer; the browser has one person and no peer to name.
        operator: { kind: 'human', peerId: 'browser' },
      })
    },
    async loadPast(_workspaceId, path, versionId) {
      // The store answers a LoroDoc; the seam answers something to draw. The
      // projection happens here so the seam stays free of CRDT types and a
      // keeper that never held one could still implement it.
      const past = await deps.store.loadPast(getBrowserWorkspaceId(), path, versionId)
      if (past === null) return null
      return deps.kind === 'markdown'
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
      await deps.record.applyRestore(past, label)
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
