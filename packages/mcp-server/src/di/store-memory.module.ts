import { TOKENS } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex, InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { ContainerModule } from 'inversify'
import { InMemoryBlobStore } from '../server/store/inmemory/index.js'

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
