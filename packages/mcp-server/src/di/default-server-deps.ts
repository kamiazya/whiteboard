import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { getDataDir } from '../server/config.js'
import { getDb } from '../server/store/db/index.js'
import { prepareDataDir } from '../server/store/db/prepare.js'
import { createContainer, resolveServerDeps } from './container.js'
import { createStoreLocalModule } from './store-local.module.js'

/**
 * The `ServerDeps` the daemon's own HTTP routes fall back to.
 *
 * `http-server.ts` builds these explicitly and hands them to `createApp`,
 * which is the path production takes. This exists for routers built WITHOUT
 * that wiring — the many route tests that construct one directly against a
 * mocked data dir, and any ad-hoc caller — so that a route needing an
 * operation does not have to be threaded through eighty construction sites
 * before it can stop reimplementing one.
 *
 * Deliberately NOT the `documentTeardown` situation, where optional meant
 * "silently absent". The fallback here is the real production wiring over
 * the same memoized database connection the legacy routes already read
 * through, so a caller that supplies nothing gets correct behaviour rather
 * than a no-op.
 *
 * `prepareDataDir` first, exactly as `document-store.ts`'s own `dbReady`
 * does, because this is the same entry condition: a caller that reaches a
 * route before anything has migrated the data dir must not meet a missing
 * table. The daemon migrates at boot and both are memoized, so on the
 * production path this is already satisfied.
 *
 * Not memoized. `getDb` already is, which is the part that costs anything;
 * what is left is a few container binds on a request that deletes a
 * document. Caching it would key on the data dir and outlive
 * `createIsolatedDb`'s `dispose()`, handing a later caller a `ServerDeps`
 * holding a destroyed connection — a real trap in exchange for a saving
 * nobody has measured.
 */
export async function getDefaultServerDeps(): Promise<ServerDeps> {
  const dataDir = getDataDir()
  await prepareDataDir(dataDir)
  const db = await getDb(dataDir)
  return resolveServerDeps(createContainer(createStoreLocalModule({ db, blobDir: dataDir })))
}
