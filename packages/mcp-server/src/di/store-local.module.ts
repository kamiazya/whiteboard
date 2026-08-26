import { TOKENS } from '@kamiazya/whiteboard-ports'
import { ContainerModule } from 'inversify'
import type { Kysely } from 'kysely'
import type { DatabaseSchema } from '../server/store/db/schema.js'
import { FsBlobStore } from '../server/store/fs/fs-blob-store.js'
import { LibsqlDocumentStore } from '../server/store/libsql/libsql-document-store.js'
import { SqliteDocumentIndex } from '../server/store/sqlite-document-index.js'
import {
  DualPlaneDocumentIndex,
  WorkspaceRoutedDocumentStore,
} from '../server/store/workspace-plane.js'

export interface StoreLocalModuleOptions {
  db: Kysely<DatabaseSchema>
  blobDir: string
}

export function createStoreLocalModule(opts: StoreLocalModuleOptions): ContainerModule {
  return new ContainerModule(({ bind }) => {
    // Both ports are routed through the workspace tree (see
    // workspace-plane.ts): content reads/writes land on the document's tree
    // node, and index mutations mirror into it, so the tool surface and the
    // daemon's own routes see one document.
    bind(TOKENS.DocumentStore)
      .toDynamicValue(() => new WorkspaceRoutedDocumentStore(new LibsqlDocumentStore(opts.db)))
      .inSingletonScope()
    bind(TOKENS.BlobStore)
      .toDynamicValue(() => new FsBlobStore(opts.blobDir))
      .inSingletonScope()
    bind(TOKENS.DocumentIndex)
      .toDynamicValue(() => new DualPlaneDocumentIndex(new SqliteDocumentIndex(opts.db), opts.db))
      .inSingletonScope()
  })
}
