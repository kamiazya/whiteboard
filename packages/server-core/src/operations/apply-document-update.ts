import type { LoroDoc } from 'loro-crdt'
import type { ServerDeps } from '../server-deps.js'
import { importWithinSyncLimits } from './apply-document-update-limit.js'

export interface ApplyDocumentUpdateInput {
  readonly workspaceId: string
  readonly path: string
  /** A Loro update (delta or full) as the client exported it. */
  readonly update: Uint8Array
}

/**
 * Applies a client's Loro update to the live doc at `path` and persists it —
 * the write half of the live-document sync surface.
 *
 * An unknown path lazy-creates rather than refusing: the sync surface's
 * update-on-a-path-nobody-made is how an empty document comes to exist, and
 * the store stamps its default kind.
 *
 * THE OPERATION HOLDS THE LOCK: the read and the write run inside one
 * `liveDocuments.withWriteLock` hold. `get` alone is unlocked at the store,
 * so a rename that runs its whole lock-protected section between an unlocked
 * read here and the save's own later lock acquisition would find no row left
 * at the old path and silently insert a brand-new phantom document back at
 * that path instead of erroring or landing on the renamed one. Holding it
 * here means a second surface cannot forget it — same reasoning as
 * `restoreVersion`.
 *
 * An engine trap in the import drops the cached doc and answers
 * `DocumentEngineTrapError`: the instance traps on every later call, so
 * keeping it would leave the document unreadable until a restart. Bytes the
 * engine refuses are rethrown as they were, with the cached doc kept. An
 * update past a text bound is thrown as its `SyncWriteRefusalError`, with
 * the cached doc dropped and nothing saved.
 *
 * Returns the live cached doc instance (not a copy), so a caller can feed
 * follow-up work — the HTTP route's auto-version trigger — without a second
 * read racing other writers.
 */
export async function applyDocumentUpdate(
  deps: Pick<ServerDeps, 'liveDocuments'>,
  input: ApplyDocumentUpdateInput,
): Promise<LoroDoc> {
  const live = deps.liveDocuments
  const { workspaceId, path, update } = input
  return live.withWriteLock(workspaceId, async () => {
    const doc = await live.get(workspaceId, path)
    importWithinSyncLimits(
      doc,
      update,
      {
        subject: `the document at ${path}`,
        fields: { workspaceId, path },
        evict: () => live.evict(workspaceId, path),
      },
      { workspaceRecord: false },
    )
    try {
      await live.save(workspaceId, path, doc, { overwrite: true })
    } catch (err) {
      // doc.import() above already mutated the cached doc, so a failed save
      // would otherwise leave the cache ahead of durable state. Evict it so
      // the next read reloads the last successfully persisted snapshot.
      live.evict(workspaceId, path)
      throw err
    }
    return doc
  })
}
