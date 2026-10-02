import { getDataDir } from '../config.js'
import { createDataLayout } from '../tenant/data-layout.js'
import type { DataLayout } from '../tenant/data-layout-seam.js'
import { SELF_HOST_TENANT_ID } from '../tenant/id.js'
import { getDb } from './db/index.js'
import { prepareDataDir } from './db/prepare.js'
import type { TenantDatabase } from './db/tenant-database.js'

/**
 * Which data directory, and which tenant, a store operation serves.
 *
 * The stores were module-level functions over the process's `getDataDir()`, so
 * two things built over different directories — `bootSelfHostDeps(dirA)`'s
 * document store and the live-document seam beside it — agreed only while the
 * global happened to equal the argument. A scope is what a composition hands
 * down instead: the operation follows the directory it was given, and the
 * process global is read in ONE place, `globalStoreScope`, for the callers that
 * have no composition above them (the routes and background workers that take
 * the keeper's only directory).
 */
export interface StoreScope {
  readonly dataDir: string
  readonly layout: DataLayout
  /**
   * The migrated database over `dataDir`. Opened per call rather than held:
   * `prepareDataDir` and `getDb` both memoize per directory, and a held handle
   * would outlive a `closeDb` the way a fixture's does.
   */
  db(): Promise<TenantDatabase>
}

/** A scope over exactly this directory. */
export function storeScope(dataDir: string, tenantId: string = SELF_HOST_TENANT_ID): StoreScope {
  return {
    dataDir,
    layout: createDataLayout(dataDir, tenantId),
    async db() {
      await prepareDataDir(dataDir)
      return getDb(dataDir, tenantId)
    },
  }
}

/**
 * The scope that follows the process's data directory, re-read at every use
 * — a root redirects it (`overrideDataDir`, a test's `setDataDirForTests`)
 * after modules that hold this have loaded, so it cannot be a snapshot.
 *
 * A DEFAULT, for the operations a router or a worker reaches without a
 * composition handing it a scope. Anything a composition builds takes its own.
 */
export const globalStoreScope: StoreScope = {
  get dataDir() {
    return getDataDir()
  },
  get layout() {
    return createDataLayout(getDataDir(), SELF_HOST_TENANT_ID)
  },
  async db() {
    return storeScope(getDataDir()).db()
  },
}
