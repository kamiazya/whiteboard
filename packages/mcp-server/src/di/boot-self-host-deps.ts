import type { FacetPlugin } from '@kamiazya/whiteboard-facet-engine'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { ensureWorkspaceId } from '../server/current-workspace.js'
import { getDb } from '../server/store/db/index.js'
import { prepareDataDir } from '../server/store/db/prepare.js'
import type { TenantDatabase } from '../server/store/db/tenant-database.js'
import { type StoreScope, storeScope } from '../server/store/store-scope.js'
import type { DataLayout } from '../server/tenant/data-layout-seam.js'
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
 * post-migration handle the ports do.
 *
 * It also returns the `StoreScope` and `DataLayout` the deps were built over,
 * and what a root does with them is the other half of serving this directory:
 *
 * - `createApp` takes the layout, derives the scope from it and hands that to
 *   every router that reaches a store (versions, maintenance, names, files,
 *   export, debug, runtime), so a route answers from the directory the deps
 *   were booted over rather than the process's;
 * - `createSharedWorkers` takes the scope: the scheduled backup (and the lease
 *   it takes in this directory's database), the file sweeper, the workspace
 *   tail and auto-compaction all work on it;
 * - the search embedder reads its weights from it.
 *
 * Everything the deps do follows `dataDir`: the stores, and the seams beside
 * them (live documents, versions, teardown, the write signal, the caches under
 * them), which take the one `StoreScope` the store module binds.
 *
 * What does NOT follow it yet, so `dataDir` must equal `getDataDir()` for
 * these (each is ledgered in `adapter-process-global-check.test.ts`):
 *
 * - the installed-font directory the export measurer and exporter read
 *   (`server/export/installed-fonts.ts`), both process singletons;
 * - resolving a handle in an address (`workspace-handle.ts`), which reads the
 *   process's workspace registry rather than the injected index;
 * - the stdio root's own background work (`stdioBackgroundWork`), which takes
 *   the process's scope by default.
 *
 * The workspace write lock and the workspace-update subscribers are keyed by
 * workspace id alone: two keepers sharing an id share a queue, which costs
 * latency and not correctness.
 */
export async function bootSelfHostDeps(
  dataDir: string,
  options: { readonly plugins?: readonly FacetPlugin[] } = {},
): Promise<{
  readonly db: TenantDatabase
  readonly serverDeps: ServerDeps
  readonly dataLayout: DataLayout
  readonly scope: StoreScope
}> {
  await prepareSelfHostDataDir(dataDir)
  const db = await getDb(dataDir)
  const scope = storeScope(dataDir)
  return {
    db,
    serverDeps: resolveSelfHostServerDeps(db, dataDir, options),
    dataLayout: scope.layout,
    scope,
  }
}
