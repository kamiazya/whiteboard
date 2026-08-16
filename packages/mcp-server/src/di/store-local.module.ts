import { TOKENS } from '@kamiazya/whiteboard-ports'
import { ContainerModule } from 'inversify'
import type { Kysely } from 'kysely'
import type { DatabaseSchema } from '../server/store/db/schema.js'
import { FsBlobStore } from '../server/store/fs/fs-blob-store.js'
import { LibsqlDocumentStore } from '../server/store/libsql/libsql-document-store.js'
import { SqliteDocumentIndex } from '../server/store/sqlite-document-index.js'

export interface StoreLocalModuleOptions {
  db: Kysely<DatabaseSchema>
  blobDir: string
}

export function createStoreLocalModule(opts: StoreLocalModuleOptions): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(TOKENS.DocumentStore)
      .toDynamicValue(() => new LibsqlDocumentStore(opts.db))
      .inSingletonScope()
    bind(TOKENS.BlobStore)
      .toDynamicValue(() => new FsBlobStore(opts.blobDir))
      .inSingletonScope()
    bind(TOKENS.DocumentIndex)
      .toDynamicValue(() => new SqliteDocumentIndex(opts.db))
      .inSingletonScope()
  })
}
