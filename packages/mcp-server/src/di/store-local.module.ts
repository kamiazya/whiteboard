import { TOKENS } from '@kamiazya/whiteboard-ports'
import { LoroWorkspaceDocumentIndex } from '@kamiazya/whiteboard-workspace-index'
import { ContainerModule } from 'inversify'
import type { Kysely } from 'kysely'
import type { DatabaseSchema } from '../server/store/db/schema.js'
import {
  CacheCoherentDocumentIndex,
  cacheBackedWorkspaceDocs,
  workspaceRegistry,
} from '../server/store/document-store.js'
import { FsBlobStore } from '../server/store/fs/fs-blob-store.js'
import { LibsqlDocumentStore } from '../server/store/libsql/libsql-document-store.js'
import { WorkspaceRoutedDocumentStore } from '../server/store/workspace-plane.js'

export interface StoreLocalModuleOptions {
  db: Kysely<DatabaseSchema>
  blobDir: string
}

export function createStoreLocalModule(opts: StoreLocalModuleOptions): ContainerModule {
  return new ContainerModule(({ bind }) => {
    // Content reads/writes land on the document's workspace-tree node (see
    // workspace-plane.ts), and the index IS the tree — the dual-plane
    // wrapper and its rows mirror retired with the documents table's
    // address-book role (dual-plane collapse S7). Cache-backed, so the
    // index operates on the same live workspace doc every other path
    // writes through.
    bind(TOKENS.DocumentStore)
      .toDynamicValue(() => new WorkspaceRoutedDocumentStore(new LibsqlDocumentStore(opts.db)))
      .inSingletonScope()
    bind(TOKENS.BlobStore)
      .toDynamicValue(() => new FsBlobStore(opts.blobDir))
      .inSingletonScope()
    bind(TOKENS.DocumentIndex)
      .toDynamicValue(
        () =>
          new CacheCoherentDocumentIndex(
            cacheBackedWorkspaceDocs(),
            new FsBlobStore(opts.blobDir),
            workspaceRegistry(),
          ),
      )
      .inSingletonScope()
  })
}
