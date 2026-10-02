import type { StorageReportPayload } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  daemonPingResponseSchema,
  type RuntimeStatusResponse,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { Hono } from 'hono'
import { hasRequiredScopes } from '../security/auth-strategy.js'
import { parseBearerAuthorizationHeader } from '../security/bearer-token.js'
import type { CredentialResolver } from '../security/credential-resolver.js'
import type { DaemonIdentity } from '../security/daemon-identity.js'
import { resolveApiRouteScope } from '../security/route-scope-registry.js'
import { readLatestCompactedAt } from '../store/document-store.js'
import type { StoreScope } from '../store/store-scope.js'

export interface RuntimeRouterOptions {
  instanceId: string
  identity: DaemonIdentity
  touch: () => void
  getStatus: () => RuntimeStatusResponse
  /**
   * Every credential this router honours, resolved in one place. REQUIRED:
   * the previous shape took the daemon token, the grant store and the pairing
   * tokens as three optional fields, which is how the macaroon came to be
   * admitted by the global `/api/*` gate and refused here — a feature the
   * route-scope registry had already declared, not working, with nothing red.
   */
  credentialResolver: CredentialResolver
  /**
   * The directory this router serves: the compaction stamp is read from this
   * scope's workspace records, and `storageReport` must walk the same
   * directory.
   */
  scope: StoreScope
  /**
   * The storage usage report for `scope`'s data directory. Handed in because
   * producing it walks the disk, which is a mechanic and not this adapter's.
   */
  storageReport: () => Promise<StorageReportPayload>
}

export function createRuntimeRouter(options: RuntimeRouterOptions) {
  const app = new Hono()

  app.get('/api/runtime/ping', (c) => {
    return c.json(
      daemonPingResponseSchema.parse({
        ok: true,
        instanceId: options.instanceId,
        identity: {
          alg: options.identity.alg,
          publicKey: options.identity.publicKey,
          did: options.identity.did,
        },
      }),
    )
  })

  app.use('/api/runtime/*', async (c, next) => {
    // The route-scope registry is the single authority on which runtime
    // routes are public and which are read vs admin — mirroring the global
    // /api/* middleware in app.ts. This per-router layer is defense in depth
    // (the global daemon-mutation middleware skips /api/runtime/*), so it
    // must accept the same credential set as the global layer for READ
    // routes: the daemon token, or a scope-checked narrower credential. The
    // admin routes accept the daemon token only. Stopping the daemon is not an HTTP route at
    // all: `whiteboard daemon stop` signals the process and the idle timer
    // calls close() directly, so no credential ends it.
    const scope = resolveApiRouteScope(c.req.method, c.req.path)
    if (scope?.kind === 'public') return next()

    const grant = await options.credentialResolver.resolve({
      secret: parseBearerAuthorizationHeader(c.req.header('authorization')),
    })
    if (grant === null) return c.json({ error: 'unauthorized' }, 401)
    if (grant.kind === 'anonymous' || grant.kind === 'daemon-token') return next()

    // This surface is STRICTER than `/api/*`'s, deliberately, and the
    // difference is the `runtime:read` test rather than the scope check that
    // follows it: a narrow credential reaches only the READ half of
    // `/api/runtime/*`, whatever scopes it holds. Dropping it in favour of
    // `hasRequiredScopes` alone would let a grant holding `runtime:admin`
    // an admin route mounted here, which the runtime surface has never allowed. That is a per-surface policy, so it stays here rather than
    // moving into the resolver.
    if (scope?.kind === 'scoped' && scope.scopes.includes('runtime:read')) {
      if (hasRequiredScopes(grant.scopes, scope.scopes)) return next()
    }
    return c.json({ error: 'unauthorized' }, 401)
  })

  app.get('/api/runtime/status', (c) => {
    options.touch()
    return c.json(options.getStatus())
  })

  // Storage usage report; nothing is cached.
  // `lastAutoCompactedAt` is the freshest auto-Optimize timestamp across
  // every canvas, so the UI can surface "Auto-optimised Ns ago" without
  // a separate round trip.
  app.get('/api/runtime/storage', async (c) => {
    options.touch()
    const report = await options.storageReport()
    const lastAutoCompactedAt = await readLatestCompactedAt(options.scope)
    return c.json({ ...report, lastAutoCompactedAt })
  })

  return app
}
