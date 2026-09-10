import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import type { LiveDocuments } from '../server-deps.js'

/** Live docs by path — what the restore operation reconciles onto. */
export class FakeLiveDocuments implements LiveDocuments {
  readonly docs = new Map<string, LoroDoc>()
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
  async kind(): Promise<DocumentKind | null> {
    return 'spatial'
  }
  async list(): Promise<readonly { id?: string; path: string }[]> {
    return [...this.docs.keys()].map((path) => ({ path }))
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
