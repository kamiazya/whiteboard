import {
  type BlobStore,
  type DocumentIndex,
  type DocumentStore,
  TOKENS,
} from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Container, type ContainerModule } from 'inversify'
import { createCanvasClientNotifier } from '../server/canvas-client-notifier.js'
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
  return {
    documentStore,
    blobStore,
    documentIndex,
    // Wired here rather than bound as a port: it is a bridge onto this
    // package's own WebSocket routes, not an interchangeable implementation
    // anyone would swap.
    clientNotifier: createCanvasClientNotifier(documentIndex),
  }
}
