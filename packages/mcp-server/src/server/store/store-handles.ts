import { LibsqlDocumentStore } from './libsql/libsql-document-store.js'
import { globalStoreScope, type StoreScope } from './store-scope.js'

// The MCP tool surface (server-core's ServerDeps) builds its own instance
// from the same one-db-per-dataDir Kysely handle, so both sides read/write
// the same `document:<documentId>` rows. The class is a stateless wrapper
// around that handle, so a fresh instance per call is equivalent.
export async function documentStoreReady(
  scope: StoreScope = globalStoreScope,
): Promise<LibsqlDocumentStore> {
  return new LibsqlDocumentStore(await scope.db())
}
