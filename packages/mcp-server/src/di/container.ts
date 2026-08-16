import { TOKENS } from '@kamiazya/whiteboard-canvas-ports'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Container, type ContainerModule } from 'inversify'
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
  return {
    documentStore: container.get(TOKENS.DocumentStore),
    blobStore: container.get(TOKENS.BlobStore),
    documentIndex: container.get(TOKENS.DocumentIndex),
  }
}
