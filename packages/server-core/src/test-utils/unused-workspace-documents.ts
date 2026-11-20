import {
  bindRecordOps,
  legacyRecordOps,
  type RecordSession,
} from '@kamiazya/whiteboard-loro-adapter'
import type { WorkspaceDocuments } from '../server-deps.js'

/**
 * A `WorkspaceDocuments` that REFUSES rather than answers — the same idiom
 * and reasoning as `unusedLiveDocuments`: a no-op double would let a test
 * that accidentally reaches the workspace doc pass while asserting nothing.
 */
export function unusedWorkspaceDocuments(): WorkspaceDocuments {
  const refuse = (method: string) => (): never => {
    throw new Error(
      `WorkspaceDocuments.${method} was called by a test that passed unusedWorkspaceDocuments().` +
        ' Pass a real implementation if the test is about the workspace doc.',
    )
  }
  return {
    exists: refuse('exists'),
    get: refuse('get'),
    // Over whatever `get` and `save` a test supplies, so a double written
    // against the record as a `LoroDoc` serves an operation that holds it as a
    // session without being written twice.
    async open(this: WorkspaceDocuments, workspaceId) {
      const doc = await this.get(workspaceId)
      return bindRecordOps(legacyRecordOps, doc, (held) => this.save(workspaceId, held))
    },
    async withRecord<T>(
      this: WorkspaceDocuments,
      workspaceId: string,
      fn: (record: RecordSession) => Promise<T>,
    ): Promise<T> {
      const doc = await this.get(workspaceId)
      const record = bindRecordOps(legacyRecordOps, doc, (held) => this.save(workspaceId, held))
      try {
        return await fn(record)
      } finally {
        record.release()
      }
    },
    save: refuse('save'),
    evictProjections: refuse('evictProjections'),
    evict: refuse('evict'),
    onUpdated: refuse('onUpdated'),
  }
}
