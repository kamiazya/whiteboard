import { getDataDir } from '../config.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import { LibsqlDocumentStore } from './libsql/libsql-document-store.js'

export async function dbReady() {
  await prepareDataDir(getDataDir())
  return getDb(getDataDir())
}

// The MCP tool surface (server-core's ServerDeps) builds its own instance
// from the same one-db-per-dataDir Kysely handle, so both sides read/write
// the same `document:<documentId>` rows. The class is a stateless wrapper
// around that handle, so a fresh instance per call is equivalent.
export async function documentStoreReady(): Promise<LibsqlDocumentStore> {
  return new LibsqlDocumentStore(await dbReady())
}
