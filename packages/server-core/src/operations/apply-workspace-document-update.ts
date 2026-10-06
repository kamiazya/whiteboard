import {
  documentsTouchedSince,
  seedNamesFromTitles,
  stampEditedDocuments,
  type TouchedDocument,
} from '@kamiazya/whiteboard-loro-adapter'
import { runEvictingOnEngineTrap } from '../document-io.js'
import { getLogger } from '../log.js'
import type { ServerDeps } from '../server-deps.js'
import { importWithinSyncLimits } from './apply-document-update-limit.js'
import { isSyncWriteRefusal } from './sync-write-refusals.js'

const log = getLogger('workspace-document')

export interface ApplyWorkspaceDocumentUpdateInput {
  readonly workspaceId: string
  /** A workspace-granularity Loro update as the client exported it. */
  readonly update: Uint8Array
  /**
   * `'edit'` (the default): the update is somebody editing, so every document
   * whose content it wrote takes a fresh `updatedAt`. `'transfer'`: a whole
   * record moved in from another keeper (a promotion), whose documents carry
   * their own clocks — the move is not an edit, and stamping it would make
   * every promoted document read "edited just now".
   */
  readonly origin?: 'edit' | 'transfer'
}

/** A document whose content an applied update wrote. */
type EditedDocument = Pick<TouchedDocument, 'documentId' | 'path'>

type ApplyWorkspaceDocumentUpdateResult =
  | { readonly kind: 'applied'; readonly edited: readonly EditedDocument[] }
  | { readonly kind: 'malformed-update' }

/**
 * Applies a client's workspace-granularity Loro update and persists it — the
 * write half of the workspace-document sync surface.
 *
 * `'malformed-update'` is a real answer, not a crash: a client can send
 * garbage bytes, and an import the engine refuses must reach the surface as a
 * 400 rather than a 500 — and must mutate nothing durable (no save, no
 * eviction; a refused import leaves the cached doc as it was).
 *
 * An engine TRAP is not a refusal and is never answered as one: the trapped
 * import may have half-applied, and the instance traps on every later call,
 * so the cached record and every projection derived from it are dropped and
 * `DocumentEngineTrapError` is thrown. The next request reloads what was
 * stored rather than meeting the dead instance — though the engine itself may
 * keep trapping on large writes until the daemon restarts (`isEngineTrap`).
 *
 * Nor is an update the keeper refuses — past a text bound, onto a path the
 * grammar refuses, or leaving a node unreadable: it is well-formed, and is
 * thrown as its `SyncWriteRefusalError` with the record and its projections
 * dropped unsaved, so nothing of it survives.
 *
 * A note at a generated path is named after its heading here, as the
 * browser keeper names it in its own store's write (`seedNameFromTitle`).
 *
 * The update does not say which documents it edits, so they are read off its
 * operations (`documentsTouchedSince`) — once, for the naming, the
 * `updatedAt` stamp, and the answer: `edited` is what a caller checkpoints.
 *
 * THE OPERATION HOLDS THE LOCK — `liveDocuments.withWriteLock`, because the
 * workspace write lock is one lock however many seams touch the workspace.
 * Import, save AND projection eviction all run inside the hold: a
 * concurrent per-document save projects, diffs and writes through the same
 * live workspace document, and a reader grabbing a stale per-document
 * projection between the import and the eviction would diff old content
 * back over this import on its next save.
 */
export async function applyWorkspaceDocumentUpdate(
  deps: Pick<ServerDeps, 'liveDocuments' | 'workspaceDocuments'>,
  input: ApplyWorkspaceDocumentUpdateInput,
): Promise<ApplyWorkspaceDocumentUpdateResult> {
  const { workspaceId, update } = input
  return deps.liveDocuments.withWriteLock(workspaceId, async () => {
    const doc = await deps.workspaceDocuments.get(workspaceId)
    const target = {
      subject: `the workspace record of ${workspaceId}`,
      fields: { workspaceId },
      evict() {
        deps.workspaceDocuments.evict(workspaceId)
        deps.workspaceDocuments.evictProjections(workspaceId)
      },
    }
    const since = doc.oplogVersion()
    try {
      importWithinSyncLimits(doc, update, target, { workspaceRecord: true })
    } catch (err: unknown) {
      if (isSyncWriteRefusal(err)) {
        throw err
      }
      log.warning('workspace-document update rejected: malformed Loro import data', {
        workspaceId,
        updateBytes: update.byteLength,
        err,
      })
      return { kind: 'malformed-update' }
    }
    // Before the save, so the name and the stamp ride the same write and its
    // fan-out hands them back to the replica that made the edit.
    const touched = runEvictingOnEngineTrap(target, 'importing an update into', () => {
      const found = documentsTouchedSince(doc, since)
      seedNamesFromTitles(doc, found)
      if (input.origin !== 'transfer') stampEditedDocuments(doc, found)
      return found
    })
    // Fan-out to subscribers happens inside save.
    await deps.workspaceDocuments.save(workspaceId, doc)
    deps.workspaceDocuments.evictProjections(workspaceId)
    const edited = touched
      .filter((each) => each.contentWritten)
      .map(({ documentId, path }) => ({ documentId, path }))
    return { kind: 'applied', edited }
  })
}
