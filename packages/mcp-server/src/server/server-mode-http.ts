// HTTP server startup for server-mode (OAuth/JWT, no local-daemon lifecycle).
//
// Server mode never idles out, which is a local-daemon concern. It serves the
// same SSE sync audience the daemon does, and reports it the same way.
// The close() returned by startServerModeHttp tears down the HTTP server
// cleanly so the dispatcher's SIGTERM handler can await it.

import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { bootSelfHostDeps } from '../di/boot-self-host-deps.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import { createApp } from './app.js'
import { startBackgroundWork } from './background-work.js'
import { attachLiveAudience } from './canvas-client-notifier.js'
import { DIST_WEB_APP_DIR, getDataDir } from './config.js'
import { isDataDirWritable } from './data-dir-writable.js'
import { startHttpRootTracing } from './observability/root-tracing.js'
import type { SignInRouteProvider, SignInRoutesDeps } from './routes/sign-in.js'
import { syncStreamStats } from './routes/sync-sse.js'
import { createAdministratorCheck } from './security/administrator-check.js'
import { type CompleteSignInDeps, createCompleteSignInDeps } from './security/complete-sign-in.js'
import type { AuthenticatorBinding } from './security/member-profile-store.js'
import type { AsyncAuthStrategy } from './security/oauth-resource-strategy.js'
import {
  type ConfiguredProvider,
  createRelyingParty,
  signsInWithBrowser,
} from './security/oidc-relying-party.js'
import type { ServerModePeople } from './security/server-mode-middleware.js'
import { createSignInAttemptStore } from './security/sign-in-attempt-store.js'
import type { OidcProvider } from './security/sign-in-config.js'
import { createTenantAdministratorStore } from './security/tenant-administrator-store.js'
import { createUserDeactivation } from './security/user-deactivation.js'
import { createUserDeletion } from './security/user-deletion.js'
import { createWorkspaceRoles } from './security/workspace-roles.js'
import { serverModeUiStatus } from './server-mode-web-app.js'
import {
  createRootShutdown,
  createSharedWorkers,
  sharedBackgroundWork,
} from './shared-background-work.js'
import { accountRetirementFor } from './store/db/account-retirement.js'
import { getDb } from './store/db/index.js'
import type { TenantDatabase } from './store/db/tenant-database.js'
import type { createFileGcSweeper } from './store/file-gc-sweeper.js'
import type { createWorkspaceTail } from './store/workspace-tail.js'

export interface StartServerModeHttpOptions {
  host: string
  port: number
  publicBaseUrl: string
  allowedOrigins: readonly string[]
  authStrategy: AsyncAuthStrategy
  /** Test-only seam, matching `startHttpServer`'s: overrides the real
   *  factory so a wiring test can assert the sweeper is armed and stopped
   *  without running a full pass. */
  fileGcSweeperFactory?: typeof createFileGcSweeper
  /** Test-only seam, matching `startHttpServer`'s. */
  workspaceTailFactory?: typeof createWorkspaceTail
  /** ADR-0046: the external providers this keeper signs people in through,
   *  secrets already resolved. None, and no sign-in route is mounted. */
  signInProviders?: readonly ConfiguredProvider[]
  /** ADR-0049 decision 2: the administrators the sign-in configuration names,
   *  as the bindings a request resolves to. */
  configuredAdministrators?: readonly AuthenticatorBinding[]
}

// How long a sign-in lasts before the person signs in again. Admission is
// re-checked at that sign-in (ADR-0046 decision 5); membership is checked on
// every request regardless, so this bounds only how stale a REFUSAL can be.
const SIGN_IN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface ServerModeRunning {
  port: number
  host: string
  startedAt: string
  resolvedDataDir: string
  /** Unique per process-start id; written into the server-mode record so
   *  stop/status/doctor can verify identity instead of trusting a reused pid. */
  instanceId: string
  close: () => Promise<void>
}

export async function startServerModeHttp(
  options: StartServerModeHttpOptions,
): Promise<ServerModeRunning> {
  await startHttpRootTracing('server')
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const instanceId = randomUUID()
  const baseUrl = `https://${options.host}:${options.port}`
  const dataDir = getDataDir()
  const { serverDeps: bootedDeps, dataLayout, scope } = await bootSelfHostDeps(dataDir)
  const shared = createSharedWorkers(instanceId, scope, options)
  const close = createRootShutdown({
    stopBackgroundWork: () => backgroundWork.stopAll(),
    closeListener: () => closeListener(server),
    flushCheckpoints: shared.checkpoints.flush,
  })

  // The same wiring the local daemon builds (http-server.ts), through the
  // same helpers. Where this root DIVERGES on purpose:
  //
  // - no macaroon root key and no workspace replica keys: both are
  //   local-daemon `createApp` options (its credential, and the read plane it
  //   hands the hosted app — ADR-0042/0043), and server mode authenticates
  //   through sign-in and bearers instead (ADR-0046);
  // - people, sessions and administration stores over the same database
  //   (`peopleOptions`), which a single-user daemon has no use for;
  // - no idle shutdown: a deployment is stopped by its operator.
  //
  // Anything not on that list that the daemon does, this root should do too:
  // the migration, the current workspace and the live audience are not
  // optional here.
  const serverDeps = attachLiveAudience(bootedDeps)

  const app = createApp({
    authMode: 'server-mode',
    serverDeps,
    dataLayout,
    onAutoVersionTrigger: shared.checkpoints.capture,
    publicBaseUrl: options.publicBaseUrl,
    allowedOrigins: options.allowedOrigins,
    authStrategy: options.authStrategy,
    ...(await peopleOptions(options, dataDir)),
    instanceId,
    touch: () => {},
    getStatus: () => ({
      ok: true,
      pid: process.pid,
      host: options.host,
      port: options.port,
      baseUrl,
      version: PACKAGE_VERSION,
      startedAt,
      uptimeMs: Date.now() - startedAtMs,
      idleForMs: 0,
      auth: { mode: 'oauth', hasToken: false },
      storage: {
        dataDir: getDataDir(),
        dataDirWritable: isDataDirWritable(getDataDir()),
      },
      // Something is always served: the web app when the image carries its
      // build (ADR-0047), the inline placeholder when it does not.
      app: { served: true, ...serverModeUiStatus(DIST_WEB_APP_DIR) },
      mcp: { httpEnabled: true, endpoint: `${baseUrl}/mcp` },
      clients: syncStreamStats(),
      publicBaseUrl: options.publicBaseUrl,
    }),
  })

  // Server mode is the MULTI-INSTANCE deployment (ADR-0020), so it is the one
  // the backup lease was built for — and until this was wired it was the one
  // deployment taking no scheduled backups at all, because this composition
  // root started no background work whatsoever. The shared set is what makes
  // that impossible to repeat: both roots declare it from one place.
  const backgroundWork = startBackgroundWork(sharedBackgroundWork(shared))

  const server = serve({ fetch: app.fetch, port: options.port, hostname: options.host })

  await new Promise<void>((resolve, reject) => {
    if ((server as unknown as { listening: boolean }).listening) {
      resolve()
      return
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    const onError = (err: Error) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    server.once('listening', onListening)
    server.once('error', onError)
  })

  return {
    port: options.port,
    host: options.host,
    startedAt,
    resolvedDataDir: getDataDir(),
    instanceId,
    close,
  }
}

function closeListener(server: { close(done: (err?: Error) => void): unknown }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

// Who is signed in, and what they may reach, is read on every request
// whether or not any provider is configured: a bearer's person is gated by
// membership too. `/auth/*` exists only for providers with a browser client —
// none means no route, not an empty one.
async function peopleOptions(
  { signInProviders, configuredAdministrators, publicBaseUrl }: StartServerModeHttpOptions,
  dataDir: string,
): Promise<{ people: ServerModePeople; signIn?: SignInRoutesDeps }> {
  const db = await getDb(dataDir)
  const deps = createCompleteSignInDeps(db, SIGN_IN_SESSION_TTL_MS)
  const appointments = createTenantAdministratorStore(db)
  const people: ServerModePeople = {
    members: deps.members,
    sessions: deps.sessions,
    roles: createWorkspaceRoles(db),
    invitations: deps.invitations,
    administration: {
      check: createAdministratorCheck({
        admins: appointments,
        members: deps.members,
        configured: configuredAdministrators ?? [],
      }),
      appointments,
      deactivation: createUserDeactivation(db),
      deletion: createUserDeletion(db, accountRetirementFor(dataDir)),
    },
    origin: new URL(publicBaseUrl).origin,
  }
  if (signInProviders === undefined || signInProviders.length === 0) return { people }
  return {
    // A bearer from a declared provider's issuer may become a user by that
    // provider's rules (ADR-0046 decision 5); see bearer-provisioning.ts.
    people: {
      ...people,
      bearerProvisioning: {
        providers: signInProviders.filter((p): p is OidcProvider => p.kind === 'oidc'),
        members: deps.members,
      },
    },
    ...signInRoutes(
      signInProviders.filter(
        (p): p is SignInRouteProvider => p.kind === 'trusted-header' || signsInWithBrowser(p),
      ),
      db,
      deps,
      people,
      publicBaseUrl,
    ),
  }
}

function signInRoutes(
  providers: readonly SignInRouteProvider[],
  db: TenantDatabase,
  signIn: CompleteSignInDeps,
  people: ServerModePeople,
  publicBaseUrl: string,
): { signIn?: SignInRoutesDeps } {
  if (providers.length === 0) return {}
  const attempts = createSignInAttemptStore(db)
  const administrators = people.administration.check
  return {
    signIn: {
      providers,
      rp: createRelyingParty(),
      attempts,
      signIn,
      administrators,
      publicBaseUrl,
    },
  }
}
