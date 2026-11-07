import { restorePointOptions } from '@kamiazya/whiteboard-history'
import {
  readDocumentContent,
  resolveWorkspaceDocumentById,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import type { LoroDoc } from 'loro-crdt'
import type { BrowserVersionStore } from './browser-version-store.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import type { VersionsBackend } from './versions-backend.js'

/**
 * The live workspace record, as much of it as versions need: read one thing
 * off it, and reconcile a past state onto it.
 *
 * `BrowserBackend` satisfies this structurally for both kinds of document;
 * naming the two methods rather than the class keeps this module free of
 * the backend's connection machinery, and lets a test hand in a record
 * without standing one up.
 */
export interface VersionsRecordSeam {
  readonly readRecord: <T>(read: (doc: LoroDoc, documentId: string) => T) => T | null
  readonly applyRestore: (past: LoroDoc, label?: string) => Promise<void>
}

/**
 * The path the version store keys `documentId`'s rows by: from the live
 * record when one is held, which knows a placement the stored copy may not
 * yet, else from the index. An id neither holds throws before any store is
 * touched.
 */
async function documentPathOf(
  deps: {
    readonly record: VersionsRecordSeam
    readonly index: Pick<DocumentIndex, 'resolveDocumentById'>
  },
  documentId: string,
): Promise<string> {
  const held = deps.record.readRecord((doc) => ({
    path: resolveWorkspaceDocumentById(doc, documentId)?.path,
  }))
  const path =
    held === null
      ? (await deps.index.resolveDocumentById({ workspaceId: getBrowserWorkspaceId(), documentId }))
          ?.path
      : held.path
  if (path === undefined) throw new Error(`no such document: ${documentId}`)
  return path
}

/**
 * The browser keeper's answer to the versions seam: rows from the
 * IndexedDB store, restores through whichever seam holds the live
 * workspace record — the two halves the daemon keeps in one process, here
 * kept in one page. Which route reaches that record is the seam's
 * business, not this module's.
 *
 * The `workspaceId` the UI passes is ignored in favour of the browser's
 * own: this backend is one browser workspace's, and a caller's id must not
 * decide which workspace's rows a read or a write lands in.
 */
export function createBrowserVersionsBackend(deps: {
  readonly store: BrowserVersionStore
  readonly record: VersionsRecordSeam
  /** Where an id is placed while no record is held: before delivery, and while reconnecting after a restore. */
  readonly index: Pick<DocumentIndex, 'resolveDocumentById'>
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
  const pathOf = (documentId: string) => documentPathOf(deps, documentId)
  return {
    list: async (_workspaceId, id) => deps.store.list(getBrowserWorkspaceId(), await pathOf(id)),
    async save(_workspaceId, documentId, { label }) {
      return deps.store.save(getBrowserWorkspaceId(), await pathOf(documentId), {
        label,
        // The person at this browser. The daemon names its humans by their
        // sync peer; the browser has one person and no peer to name.
        operator: { kind: 'human' },
      })
    },
    async loadPast(_workspaceId, documentId, versionId) {
      // The store answers a LoroDoc; the seam answers something to draw. The
      // projection happens here so the seam stays free of CRDT types and a
      // keeper that never held one could still implement it.
      const past = await deps.store.loadPast(
        getBrowserWorkspaceId(),
        await pathOf(documentId),
        versionId,
      )
      if (past === null) return null
      return readDocumentContent(past, deps.kind)
    },
    async restore(_workspaceId, documentId, versionId) {
      const workspaceId = getBrowserWorkspaceId()
      const path = await pathOf(documentId)
      const past = await deps.store.loadPast(workspaceId, path, versionId)
      if (past === null) throw new Error(`no such version: ${versionId}`)
      const label = (await deps.store.list(workspaceId, path)).find(
        (v) => v.id === versionId,
      )?.label
      await deps.record.applyRestore(past, label)
      // The point the restore produced, recorded as the daemon's operation
      // records it — automatic, naming what it restored: a restore reconciles
      // a past state onto the live one, and a restore that leaves no row is
      // one nobody can find afterwards. Best effort for the same reason as there — the content
      // has already landed, so a failed row costs the history a point and the
      // document nothing.
      try {
        await deps.store.save(workspaceId, path, restorePointOptions(versionId))
      } catch {
        // See above.
      }
    },
  }
}
