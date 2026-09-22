import { TOKENS } from '@kamiazya/whiteboard-ports'
import { ContainerModule } from 'inversify'
import type { TenantDatabase } from '../server/store/db/tenant-database.js'
import {
  CacheCoherentDocumentIndex,
  cacheBackedWorkspaceDocs,
  workspaceRegistry,
} from '../server/store/document-store.js'
import { FsBlobStore } from '../server/store/fs/fs-blob-store.js'
import { LibsqlDocumentStore } from '../server/store/libsql/libsql-document-store.js'
import { WorkspaceRoutedDocumentStore } from '../server/store/workspace-plane.js'
import { blobsRoot } from '../server/tenant/data-layout.js'
import { SELF_HOST_TENANT_ID } from '../server/tenant/id.js'

export interface StoreLocalModuleOptions {
  db: TenantDatabase
  /** The data directory; where inside it this tenant's bytes go is `data-layout.ts`'s. */
  dataDir: string
  tenantId: string
}

function tenantBlobStore(opts: StoreLocalModuleOptions): FsBlobStore {
  return new FsBlobStore(blobsRoot(opts.dataDir, opts.tenantId), opts.dataDir)
}

/**
 * The local stores for the keeper's only tenant. A many-tenant keeper binds
 * per request and calls `createStoreLocalModule` with that tenant instead;
 * every composition root today holds one, so this is the one place the
 * self-host tenant is chosen.
 */
export function createSelfHostStoreLocalModule(
  db: TenantDatabase,
  dataDir: string,
): ContainerModule {
  return createStoreLocalModule({ db, dataDir, tenantId: SELF_HOST_TENANT_ID })
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
      .toDynamicValue(() => tenantBlobStore(opts))
      .inSingletonScope()
    bind(TOKENS.DocumentIndex)
      .toDynamicValue(
        () =>
          new CacheCoherentDocumentIndex(
            cacheBackedWorkspaceDocs(),
            tenantBlobStore(opts),
            workspaceRegistry(),
          ),
      )
      .inSingletonScope()
  })
}
