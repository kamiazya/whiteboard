import { TOKENS } from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Container, type ContainerModule } from 'inversify'
import { createOpentypeMeasureText } from '../server/export/measure-text.js'
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
    // The real font metrics, so `wb_scene_render` and `wb_scene_digest`
    // measure text the same way an export does. Without this the tools fall
    // back to a constant-ratio estimate while the PNG exporter — same
    // process, same canvas — uses opentype.js, and the two disagree on
    // where every wrapped line lands. Memoized inside the measurer, so this
    // reference costs nothing until a render actually asks for it.
    measure: createOpentypeMeasureText,
  }
}
