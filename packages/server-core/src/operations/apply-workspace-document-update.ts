import { getLogger } from '../log.js'
import type { ServerDeps } from '../server-deps.js'

const log = getLogger('workspace-document')

export interface ApplyWorkspaceDocumentUpdateInput {
  readonly workspaceId: string
  /** A workspace-granularity Loro update as the client exported it. */
  readonly update: Uint8Array
}

/**
 * Applies a client's workspace-granularity Loro update and persists it — the
 * write half of the workspace-document sync surface.
 *
 * `'malformed-update'` is a real answer, not a crash: a client can send
 * garbage bytes, and a throwing import must reach the surface as a 400
 * rather than a 500 — and must mutate nothing durable (no save, no
 * eviction; the in-memory import either applied atomically or threw).
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
): Promise<'applied' | 'malformed-update'> {
  const { workspaceId, update } = input
  return deps.liveDocuments.withWriteLock(workspaceId, async () => {
    const doc = await deps.workspaceDocuments.get(workspaceId)
    try {
      doc.import(update)
    } catch (err: unknown) {
      log.warning('workspace-document update rejected: malformed Loro import data', {
        workspaceId,
        updateBytes: update.byteLength,
        err,
      })
      return 'malformed-update'
    }
    // Fan-out to subscribers happens inside save.
    await deps.workspaceDocuments.save(workspaceId, doc)
    deps.workspaceDocuments.evictProjections(workspaceId)
    return 'applied'
  })
}
