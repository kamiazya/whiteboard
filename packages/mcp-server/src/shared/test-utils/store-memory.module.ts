import { TOKENS } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex, InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { ContainerModule } from 'inversify'
import { InMemoryBlobStore } from '../../server/store/inmemory/index.js'

/**
 * Binds the storage ports to their in-memory test doubles. Test-level
 * composition only: `createContainer` takes its store module as an argument
 * so production can never default to this, and `no-production-wiring.test.ts`
 * with arch-lint's `no-test-utils-in-production` keep it out of the build.
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
