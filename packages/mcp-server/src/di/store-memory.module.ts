import { TOKENS } from '@kamiazya/whiteboard-canvas-ports'
import { ContainerModule } from 'inversify'
import { InMemoryBlobStore, InMemoryCanvasDocStore } from '../server/store/inmemory/index.js'

/**
 * Binds the storage ports to their in-memory test doubles. Test-level
 * composition only — see `no-production-wiring.test.ts` for the guard that
 * keeps this out of the live server until a real store impl replaces it.
 */
export const storeMemoryModule = new ContainerModule(({ bind }) => {
  bind(TOKENS.CanvasDocStore)
    .toDynamicValue(() => new InMemoryCanvasDocStore())
    .inSingletonScope()
  bind(TOKENS.BlobStore)
    .toDynamicValue(() => new InMemoryBlobStore())
    .inSingletonScope()
})
