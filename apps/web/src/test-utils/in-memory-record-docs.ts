/**
 * One snapshot and no log: enough to stand in for the workspace record where a
 * test is about what a keeper does with it and not about how IndexedDB stores
 * it. The cursor reads reject rather than answer empty, so a test that tails
 * the record fails against a double that cannot.
 */
import {
  lease,
  leaseKind,
  loadCrdtEngine,
  type RecordLease,
} from '@kamiazya/whiteboard-loro-adapter'
import type { WorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'

const kind = leaseKind(loadCrdtEngine)

export class InMemoryRecordDocs implements WorkspaceDocs<RecordLease> {
  private stored: Uint8Array | null = null

  async open(_workspaceId?: string): Promise<RecordLease | null> {
    return this.stored === null ? null : kind.load(this.stored, [])
  }

  async create(workspaceId: string): Promise<RecordLease> {
    const existing = await this.open(workspaceId)
    if (existing !== null) return existing
    const record = await kind.load(new LoroDoc().export({ mode: 'snapshot' }), [])
    await this.save(workspaceId, record)
    return record
  }

  async save(_workspaceId: string, record: RecordLease): Promise<Uint8Array | null> {
    this.stored = lease.exportSnapshot(record)
    return this.stored
  }

  /** What is stored, as a document a test reads with the adapter's own readers. */
  openDoc(): LoroDoc | null {
    if (this.stored === null) return null
    const doc = new LoroDoc()
    doc.import(this.stored)
    return doc
  }

  async readCursor(): Promise<never> {
    throw new Error('not implemented')
  }

  async catchUp(): Promise<never> {
    throw new Error('not implemented')
  }

  async storedVersion(): Promise<never> {
    throw new Error('not implemented')
  }
}
