import {
  bindRecordOps,
  createWorkspaceDocumentAtPath,
  legacyRecordOps,
  projectWorkspaceDocument,
  type RecordSession,
  readWorkspaceDocuments,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { generateDocumentId } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import type { LiveDocuments, WorkspaceDocuments } from '../server-deps.js'
import { unusedWorkspaceDocuments } from './unused-workspace-documents.js'

/** Live docs by path — what the restore operation reconciles onto. */
export class FakeLiveDocuments implements LiveDocuments {
  readonly docs = new Map<string, LoroDoc>()
  /** Kinds by path; a path with no entry is spatial. */
  readonly kinds = new Map<string, DocumentKind>()
  async get(_workspaceId: string, path: string): Promise<LoroDoc> {
    let doc = this.docs.get(path)
    if (doc === undefined) {
      doc = new LoroDoc()
      this.docs.set(path, doc)
    }
    return doc
  }
  async save(_workspaceId: string, path: string, doc: LoroDoc): Promise<void> {
    this.docs.set(path, doc)
  }
  async exists(_workspaceId: string, path: string): Promise<boolean> {
    return this.docs.has(path)
  }
  kind(_workspaceId: string, path: string): Promise<DocumentKind | null> {
    return Promise.resolve(this.kinds.get(path) ?? 'spatial')
  }
  /** Ids by path, minted the first time a row is listed and stable after. */
  private readonly ids = new Map<string, string>()
  async list(): Promise<readonly { documentId?: string; path: string }[]> {
    return [...this.docs.keys()].map((path) => {
      const documentId = this.ids.get(path) ?? generateDocumentId()
      this.ids.set(path, documentId)
      return { documentId, path }
    })
  }
  /**
   * The record a restore writes into, over these documents: opened from what
   * they hold and saved back into them.
   */
  workspaceDocuments(): WorkspaceDocuments {
    const live = this
    return {
      ...unusedWorkspaceDocuments(),
      async withRecord<T>(_workspaceId: string, fn: (record: RecordSession) => Promise<T>) {
        const record = new LoroDoc()
        for (const { documentId, path } of await live.list()) {
          createWorkspaceDocumentAtPath(record, {
            path,
            documentId: documentId as string,
            kind: live.kinds.get(path) ?? 'spatial',
          })
          writeWorkspaceDocumentContent(
            record,
            documentId as string,
            live.docs.get(path) as LoroDoc,
          )
        }
        const session = bindRecordOps(legacyRecordOps, record, async () => {
          for (const entry of readWorkspaceDocuments(record)) {
            const projected = projectWorkspaceDocument(record, entry.documentId)
            if (projected !== null) live.docs.set(entry.path, projected)
            live.kinds.set(entry.path, entry.kind)
          }
        })
        try {
          return await fn(session)
        } finally {
          session.release()
        }
      },
      evict() {},
      evictProjections() {},
    }
  }
  async rename(): Promise<void> {
    throw new Error('not exercised')
  }
  async delete(): Promise<void> {
    throw new Error('not exercised')
  }
  evict(): void {}
  async withWriteLock<T>(_workspaceId: string, fn: () => Promise<T>): Promise<T> {
    return fn()
  }
}
