import { judgeWorkspaceSyncImport, UnjudgedImportError } from '@kamiazya/whiteboard-loro-adapter'
import { type CachedTarget, runEvictingOnEngineTrap } from '../document-io.js'
import { getLogger } from '../log.js'
import { isSyncWriteRefusal, type SyncWriteRefusalError } from './sync-write-refusals.js'
import { workspaceSyncRefusal } from './workspace-sync-refusal.js'

const log = getLogger('sync-write-limit')

function refuse(target: CachedTarget, error: SyncWriteRefusalError): never {
  target.evict()
  log.warning('sync write refused', { ...target.fields, reason: error.message })
  throw error
}

/**
 * Imports a client's update into a CACHED workspace record unless it breaks a
 * text bound (`SYNC_TEXT_BREACH_CODES` lists them) or what the record's
 * readers need of a node — in which case nothing of it is kept, and the
 * refusal is thrown as its `SyncWriteRefusalError`.
 *
 * What the update does to text and to the record is
 * `judgeWorkspaceSyncImport`'s judgement, the one every keeper of a workspace
 * record takes: text bounds, the kind an envelope may say, and — for an
 * update that writes a workspace node's meta or moves one — readable node
 * meta, the path grammar and the name bound. A body edit pays nothing for
 * the placement checks.
 *
 * Every refusal drops the cached instance instead of saving, so the next
 * read rebuilds it from storage and nothing of the write survives — and so
 * does any other throw once the import has landed: a judge that fails rather
 * than answering has judged nothing, and the instance still holds the
 * update. So does an update that builds on a change the instance lacks, whose
 * parked changes no judge reads (`CausalGapError`). Only bytes the engine
 * refuses outright leave the instance kept,
 * since the import took nothing in. Everything from the import to the
 * refusal is synchronous, so no other request sees the half-taken state.
 */
export function importWithinSyncLimits(
  doc: Parameters<typeof judgeWorkspaceSyncImport>[0],
  update: Uint8Array,
  target: CachedTarget,
): void {
  const trapped = { ...target, fields: { ...target.fields, updateBytes: update.byteLength } }
  try {
    const breach = runEvictingOnEngineTrap(trapped, 'importing an update into', () =>
      judgeWorkspaceSyncImport(doc, update),
    )
    if (breach !== null) refuse(target, workspaceSyncRefusal(breach))
  } catch (err) {
    // A refusal and an engine trap have dropped the instance already.
    if (err instanceof UnjudgedImportError && !isSyncWriteRefusal(err)) {
      target.evict()
      log.warning('sync write could not be judged; the cached copy was dropped', {
        ...trapped.fields,
        err,
      })
    }
    throw err
  }
}
