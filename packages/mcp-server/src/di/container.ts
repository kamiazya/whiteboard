import {
  type BlobStore,
  type DocumentIndex,
  type DocumentStore,
  TOKENS,
} from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import type { LoroWorkspaceDocumentIndex } from '@kamiazya/whiteboard-workspace-index'
import { Container, type ContainerModule } from 'inversify'
import { createCanvasClientNotifier } from '../server/canvas-client-notifier.js'
import { createOpentypeMeasureText } from '../server/export/measure-text.js'
import { resolveSearchEmbedder } from '../server/search/search-embedder.js'
import { documentTeardown } from '../server/store/document-store.js'
import { documentWritten } from '../server/store/document-written.js'
import { FileVersionStore } from '../server/store/version-store.js'
import { storeMemoryModule } from './store-memory.module.js'

export function createContainer(storeModule: ContainerModule = storeMemoryModule): Container {
  const container = new Container()
  container.load(storeModule)
  return container
}

/**
 * Assembles ServerDeps by resolving the store/sync port tokens from a
 * DI container. Inversify already throws a descriptive "not bound" error
 * when a token has no binding, so this simply surfaces that failure instead
 * of letting a missing binding silently produce undefined deps.
 */
export function resolveServerDeps(container: Container): ServerDeps {
  // Order matters to container.test.ts, which asserts the not-bound error
  // names DocumentStore — the first token resolved.
  const documentStore: DocumentStore = container.get(TOKENS.DocumentStore)
  const blobStore: BlobStore = container.get(TOKENS.BlobStore)
  const documentIndex: DocumentIndex = container.get(TOKENS.DocumentIndex)
  const trashCapable =
    'listTrash' in documentIndex && 'restoreDocument' in documentIndex
      ? (documentIndex as DocumentIndex & LoroWorkspaceDocumentIndex)
      : null
  return {
    documentStore,
    blobStore,
    documentIndex,
    // The trash seam, present exactly when the bound index is the tree-backed
    // one (listTrash/restoreDocument are its capability, not the port's).
    // Structural rather than instanceof: the binding is this composition
    // root's own choice, and vitest's module-graph split makes instanceof
    // lie across realms (see ports' isWorkspaceNotFoundError).
    ...(trashCapable === null
      ? {}
      : {
          trash: {
            list: async (input: { workspaceId: string }) =>
              (await trashCapable.listTrash(input)).map((entry) => ({
                documentId: entry.documentId,
                path: entry.path,
                deletedAt: entry.deletedAt,
              })),
            restore: (input: { workspaceId: string; documentId: string }) =>
              trashCapable.restoreDocument(input),
          },
        }),
    // The real font metrics, so every tool that lays a scene out measures
    // text the same way an export does. Without this they fall back to a
    // constant-ratio estimate while the PNG exporter — same process, same
    // canvas — uses opentype.js, and the two disagree on where every wrapped
    // line lands. Memoized inside the measurer, so this reference costs
    // nothing until a render actually asks for it.
    measure: createOpentypeMeasureText,
    // Wired here rather than bound as a port: it is a bridge onto this
    // package's own WebSocket routes, not an interchangeable implementation
    // anyone would swap.
    clientNotifier: createCanvasClientNotifier(documentIndex),
    // undefined unless the user opted in, and even then the model loads on
    // the first search rather than here — a daemon that starts must not pay
    // a model download before it can answer anything.
    embedder: resolveSearchEmbedder(),
    // Wired here for the same reason clientNotifier is: it is this package's
    // own filesystem and doc cache, not an interchangeable implementation.
    // Without it wb_document_delete removes the rows and leaves the
    // thumbnails, the blob and a cached doc instance behind — the HTTP
    // DELETE has always cleaned those up, and the two paths disagreeing is
    // the defect this closes.
    documentTeardown,
    // Same reason as documentTeardown: this package's own op-log
    // maintenance, not an interchangeable implementation. Wired HERE rather
    // than in the HTTP route registration, which is what confined the old
    // saved-listener to one deployment shape.
    documentWritten,
    // The daemon's own version store satisfies the seam structurally: it has
    // eleven methods and the seam names the three an operation reads, so no
    // adapter class is needed to bridge them.
    versions: new FileVersionStore(),
  }
}
