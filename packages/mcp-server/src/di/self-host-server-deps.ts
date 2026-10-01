import type { FacetPlugin } from '@kamiazya/whiteboard-facet-engine'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { daemonDeviceActor } from '../server/daemon-actor.js'
import type { TenantDatabase } from '../server/store/db/tenant-database.js'
import { createContainer, resolveServerDeps } from './container.js'
import { createSelfHostStoreLocalModule } from './store-local.module.js'

/**
 * The one way a self-hosting root turns a data dir into `ServerDeps`: the
 * local store module over the migrated database, and this daemon as the
 * OKF actor an agent save is stamped with.
 *
 * One function because the sequence was hand-copied at five sites (both
 * HTTP roots, the stdio root, the routes' fallback and a test seeder), and
 * the copy in the stdio root had quietly dropped the plugin set — so a
 * deployment's `facetPlugins` reached every REST route and no MCP tool.
 */
export function resolveSelfHostServerDeps(
  db: TenantDatabase,
  dataDir: string,
  options: { readonly plugins?: readonly FacetPlugin[] } = {},
): ServerDeps {
  return resolveServerDeps(createContainer(createSelfHostStoreLocalModule(db, dataDir)), {
    ...(options.plugins === undefined ? {} : { plugins: options.plugins }),
    daemonActor: daemonDeviceActor(dataDir),
  })
}
