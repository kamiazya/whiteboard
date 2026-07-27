import { Container } from 'inversify'
import { storeMemoryModule } from './store-memory.module.js'

/**
 * Builds this repo's first InversifyJS composition root: a plain
 * `Container` with `ContainerModule`s loaded synchronously (every binding
 * here is sync, so `load` — not `loadAsync` — is correct). No decorators or
 * `reflect-metadata` are involved; every binding uses `toDynamicValue`
 * against the canvas-ports Symbol tokens.
 *
 * Test-level composition only for now — see `no-production-wiring.test.ts`.
 */
export function createContainer(): Container {
  const container = new Container()
  container.load(storeMemoryModule)
  return container
}
