import { TOKENS } from '@kamiazya/whiteboard-canvas-ports'
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-canvas-ports/test-utils'
import { ContainerModule } from 'inversify'
import { InMemoryBlobStore, InMemoryDocumentStore } from '../server/store/inmemory/index.js'

/**
 * Binds the storage ports to their in-memory test doubles. Test-level
 * composition only — see `no-production-wiring.test.ts` for the guard that
 * keeps this out of the live server until a real store impl replaces it.
 */
export const storeMemoryModule = new ContainerModule(({ bind }) => {
  bind(TOKENS.DocumentStore)
    .toDynamicValue(() => new InMemoryDocumentStore())
    .inSingletonScope()
  bind(TOKENS.BlobStore)
    .toDynamicValue(() => new InMemoryBlobStore())
    .inSingletonScope()
  bind(TOKENS.DocumentIndex)
    .toDynamicValue(() => new InMemoryDocumentIndex())
    .inSingletonScope()
})
