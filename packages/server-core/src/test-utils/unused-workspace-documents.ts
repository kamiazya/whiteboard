import {
  bindRecordOps,
  legacyRecordOps,
  type RecordSession,
} from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'
import type { WorkspaceDocuments } from '../server-deps.js'

/**
 * A `WorkspaceDocuments` whose record a test holds as a `LoroDoc`: `get` and
 * `save` are the test's own, and `withRecord` binds a session over them, so a
 * double written against the document serves an operation that holds the record
 * as a session without being written twice. Neither is part of the seam.
 */
export interface WorkspaceDocumentsOverDoc extends WorkspaceDocuments {
  get(workspaceId: string): Promise<LoroDoc>
  save(workspaceId: string, doc: LoroDoc): Promise<void>
}

/**
 * A `WorkspaceDocuments` that REFUSES rather than answers — the same idiom
 * and reasoning as `unusedLiveDocuments`: a no-op double would let a test
 * that accidentally reaches the workspace doc pass while asserting nothing.
 */
export function unusedWorkspaceDocuments(): WorkspaceDocumentsOverDoc {
  const refuse = (method: string) => (): never => {
    throw new Error(
      `WorkspaceDocuments.${method} was called by a test that passed unusedWorkspaceDocuments().` +
        ' Pass a real implementation if the test is about the workspace doc.',
    )
  }
  return {
    exists: refuse('exists'),
    get: refuse('get'),
    async withRecord<T>(
      this: WorkspaceDocumentsOverDoc,
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
    evict: refuse('evict'),
    onUpdated: refuse('onUpdated'),
  }
}
