import type { BlobStore, DocumentIndex, DocumentStore } from '@kamiazya/whiteboard-ports'

export interface ServerDeps {
  documentStore: DocumentStore
  blobStore: BlobStore
  /**
   * Where a document's placement lives. Separate from `documentStore`, which
   * owns one document's bytes and knows nothing about where it sits — and the
   * reason an agent-created document is one the user's canvas list can show:
   * both surfaces now write the same index.
   */
  documentIndex: DocumentIndex
}
