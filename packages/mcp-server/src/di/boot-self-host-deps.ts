import type { FacetPlugin } from '@kamiazya/whiteboard-facet-engine'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { ensureWorkspaceId } from '../server/current-workspace.js'
import { getDb } from '../server/store/db/index.js'
import { prepareDataDir } from '../server/store/db/prepare.js'
import type { TenantDatabase } from '../server/store/db/tenant-database.js'
import { createDataLayout } from '../server/tenant/data-layout.js'
import type { DataLayout } from '../server/tenant/data-layout-seam.js'
import { SELF_HOST_TENANT_ID } from '../server/tenant/id.js'
import { resolveSelfHostServerDeps } from './self-host-server-deps.js'

/**
 * Makes a data dir ready to be read: migrated, and holding the workspace the
 * current-workspace marker names. Both steps are memoized per data dir, so a
 * second caller on a prepared dir pays nothing.
 *
 * The order is the contract. `getDb` opens the file and nothing more, so a
 * handle taken before the migration answers `no such table: workspaces`; and
 * a root that skipped `ensureWorkspaceId` served an empty workspace list a
 * browser could not select out of. `ensureWorkspaceId` happens to run
 * `prepareDataDir` itself, which is how a root once got migrated by accident —
 * naming both here is what stops that being load-bearing.
 */
export async function prepareSelfHostDataDir(dataDir: string): Promise<void> {
  await prepareDataDir(dataDir)
  await ensureWorkspaceId(dataDir)
}

/**
 * The one boot sequence every self-hosting composition root runs — the local
 * daemon, server mode and the stdio entry: prepare the data dir, open the
 * database, build `ServerDeps` over it. A root takes the database from here
 * for its own stores (people, replica keys) so they see the same
 * post-migration handle the ports do, and the data layout for `createApp`, so
 * the routes serve the directory and tenant these deps were built over.
 */
export async function bootSelfHostDeps(
  dataDir: string,
  options: { readonly plugins?: readonly FacetPlugin[] } = {},
): Promise<{
  readonly db: TenantDatabase
  readonly serverDeps: ServerDeps
  readonly dataLayout: DataLayout
}> {
  await prepareSelfHostDataDir(dataDir)
  const db = await getDb(dataDir)
  return {
    db,
    serverDeps: resolveSelfHostServerDeps(db, dataDir, options),
    dataLayout: createDataLayout(dataDir, SELF_HOST_TENANT_ID),
  }
}
