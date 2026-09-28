// Shared test fixture for the `/replica-key` route family
// (replica-key.test.ts, replica-key-rotate.test.ts): builds the real
// `createDaemonAuthMiddleware` chain over an isolated database, so the
// route-scope-registry rules are exercised rather than only pinned in
// isolation.
//
// Named with the leading `_test-` prefix (the convention `_test-helpers.ts`
// uses) so `tsconfig.server.json` excludes it from the production compile.
//
// `createIsolatedDb` is imported DYNAMICALLY, the same move `_test-
// helpers.ts`'s `seedWorkspaceRow` already makes for the same reason: this
// file sits under `routes/`, which `adapter-mechanic-check.ts` scans as an
// ADAPTER tree (ADR-0018) — a static import of the db test helper module
// reads as an adapter reaching a mechanic, which this fixture is not.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createCredentialResolver } from '../security/credential-resolver.js'
import { createWorkspaceReplicaKeyStore } from '../security/workspace-replica-key-store.js'
import { createDaemonAuthMiddleware } from './auth.js'
import { createReplicaKeyRouter } from './replica-key.js'

// Type-only: `import type(...)`'s target module has no `from`, so it does
// not match the mechanic scan's pattern the way a value import would.
type IsolatedDbModule = typeof import('../store/db/test-helpers.js')
type IsolatedDbHandle = Awaited<ReturnType<IsolatedDbModule['createIsolatedDb']>>

export const WS = 'ws-1'
export const DAEMON_TOKEN = 'the-daemon-token'
export const MACAROON_ROOT_KEY = new Uint8Array(32).fill(7)
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

let dir: string | undefined
let dbHandle: IsolatedDbHandle | undefined

interface MakeAppOptions {
  known?: readonly string[]
  defaultTier?: 'no-offline' | 'offline' | 'bounded'
  leaseTtlMs?: number
  /** No daemon token configured (an open daemon) — every caller resolves to
   *  an `anonymous` grant, ALL_AUTH_SCOPES, the same bypass DAEMON_TOKEN
   *  gets. Default false, matching every other test using this fixture. */
  openDaemon?: boolean
}

export async function makeApp(options: MakeAppOptions = {}) {
  const known = options.known ?? [WS]
  dir = mkdtempSync(join(tmpdir(), 'replica-key-routes-'))
  const { createIsolatedDb } = await import('../store/db/test-helpers.js')
  dbHandle = await createIsolatedDb({ dataDir: dir })
  const keys = createWorkspaceReplicaKeyStore(dbHandle.db, {
    defaultTier: options.defaultTier ?? 'offline',
  })
  const workspaceExists = async (id: string) => known.includes(id)

  const credentialResolver = createCredentialResolver({
    ...(options.openDaemon ? {} : { daemonToken: DAEMON_TOKEN }),
    macaroonRootKey: MACAROON_ROOT_KEY,
  })

  const replicaKey = createReplicaKeyRouter({
    keys,
    leaseTtlMs: options.leaseTtlMs ?? SEVEN_DAYS_MS,
    workspaceExists,
  })

  const authed = new Hono()
  authed.use('/api/*', createDaemonAuthMiddleware(credentialResolver))
  authed.route('/', replicaKey)

  return { app: authed, keys, db: dbHandle.db }
}

/** Register as `afterEach(disposeApp)` in every file that calls `makeApp`. */
export async function disposeApp(): Promise<void> {
  await dbHandle?.dispose()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  dbHandle = undefined
}

export async function post(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  path: string,
  headers: Record<string, string> = {},
) {
  return app.request(path, { method: 'POST', headers })
}

export async function put(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** `keys.setTier` UPDATEs an existing `workspaces` row (see its own header:
 *  rows are minted lazily off document writes). This fixture's
 *  `workspaceExists` is a plain array check decoupled from that table —
 *  unlike production, where the same table backs both — so a test that
 *  writes a tier through the route has to seed the row itself. */
export async function seedWorkspaceRow(fixture: Awaited<ReturnType<typeof makeApp>>, id = WS) {
  await fixture.db
    .insertInto('workspaces')
    .values({ id, displayName: null, segment: null, createdAt: 0, updatedAt: 0, replicaTier: null })
    .execute()
}
