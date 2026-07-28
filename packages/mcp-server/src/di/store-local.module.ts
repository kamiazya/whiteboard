import { TOKENS } from '@kamiazya/whiteboard-canvas-ports'
import { ContainerModule } from 'inversify'
import type { Kysely } from 'kysely'
import type { DatabaseSchema } from '../server/store/db/schema.js'
import { FsBlobStore } from '../server/store/fs/fs-blob-store.js'
import { LibsqlCanvasDocStore } from '../server/store/libsql/libsql-canvas-doc-store.js'
import { LibsqlWorkspaceIndex } from '../server/store/libsql/libsql-workspace-index.js'

export interface StoreLocalModuleOptions {
  db: Kysely<DatabaseSchema>
  blobDir: string
}

export function createStoreLocalModule(opts: StoreLocalModuleOptions): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(TOKENS.CanvasDocStore)
      .toDynamicValue(() => new LibsqlCanvasDocStore(opts.db))
      .inSingletonScope()
    bind(TOKENS.BlobStore)
      .toDynamicValue(() => new FsBlobStore(opts.blobDir))
      .inSingletonScope()
    bind(TOKENS.WorkspaceIndex)
      .toDynamicValue(() => new LibsqlWorkspaceIndex(opts.db))
      .inSingletonScope()
  })
}
