import {
  daemonPingResponseSchema,
  runtimeVerifyRequestSchema,
  runtimeVerifyResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/runtime'
import { errorBody, invalidRequestBody } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { purgeOldDaemonLogs } from '../../daemon/log-rotation.js'
import { getDataDir } from '../config.js'
import type { RuntimeStatus } from '../http-server.js'
import { hasRequiredScopes } from '../security/auth-strategy.js'
import { parseBearerAuthorizationHeader } from '../security/bearer-token.js'
import type { CredentialResolver } from '../security/credential-resolver.js'
import type { DaemonIdentity } from '../security/daemon-identity.js'
import { resolveApiRouteScope } from '../security/route-scope-registry.js'
import { readLatestCompactedAt } from '../store/document-store.js'
import { computeStorageReport } from './runtime-storage.js'

// /api/runtime/verify is public and does an Ed25519 sign per call, so cap
// the rate. Loopback traffic makes per-IP buckets meaningless — one global
// sliding window is enough to stop a tight local loop from burning CPU.
const VERIFY_RATE_LIMIT = 60
const VERIFY_RATE_WINDOW_MS = 60_000

export interface RuntimeRouterOptions {
  instanceId: string
  identity: DaemonIdentity
  touch: () => void
  getStatus: () => RuntimeStatus
  /**
   * Every credential this router honours, resolved in one place. REQUIRED:
   * the previous shape took the daemon token, the grant store and the pairing
   * tokens as three optional fields, which is how the macaroon came to be
   * admitted by the global `/api/*` gate and refused here — a feature the
   * route-scope registry had already declared, not working, with nothing red.
   */
  credentialResolver: CredentialResolver
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

  // Challenge-response proof of identity (see security/daemon-identity.ts).
  // Public like ping: the response is only useful to a caller that has the
  // real daemon's key PINNED — a squatter answering with its own key fails
  // the browser-side verification.
  let verifyWindowStartMs = 0
  let verifyWindowCount = 0
  app.post('/api/runtime/verify', async (c) => {
    const now = Date.now()
    if (now - verifyWindowStartMs >= VERIFY_RATE_WINDOW_MS) {
      verifyWindowStartMs = now
      verifyWindowCount = 0
    }
    verifyWindowCount += 1
    if (verifyWindowCount > VERIFY_RATE_LIMIT) {
      return c.json(
        errorBody('rate_limited', 'too many verification attempts; try again shortly'),
        429,
      )
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(errorBody('invalid_body', 'the request body is not valid JSON'), 400)
    }
    const parsed = runtimeVerifyRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json(invalidRequestBody(parsed.error), 400)
    }
    // Binding the Origin header stops a relay from farming signatures that
    // verify for a different origin's challenge; a missing header binds "".
    const origin = c.req.header('origin') ?? ''
    const signature = options.identity.sign(['wb-verify-v1', parsed.data.nonce, origin])
    return c.json(
      runtimeVerifyResponseSchema.parse({
        alg: options.identity.alg,
        publicKey: options.identity.publicKey,
        signature,
      }),
    )
  })

  app.use('/api/runtime/*', async (c, next) => {
    // The route-scope registry is the single authority on which runtime
    // routes are public and which are read vs admin — mirroring the global
    // /api/* middleware in app.ts. This per-router layer is defense in depth
    // (the global daemon-mutation middleware skips /api/runtime/*), so it
    // must accept the same credential set as the global layer for READ
    // routes: daemon token, scope-checked OAuth grant, or an origin-bound
    // pairing session token. The admin routes (touch, logs prune) accept the
    // daemon token only — a paired web origin can inspect the daemon but
    // never delete its logs. Stopping the daemon is not an HTTP route at
    // all: `whiteboard daemon stop` signals the process and the idle timer
    // calls close() directly, so no credential ends it.
    const scope = resolveApiRouteScope(c.req.method, c.req.path)
    if (scope?.kind === 'public') return next()

    const grant = await options.credentialResolver.resolve({
      secret: parseBearerAuthorizationHeader(c.req.header('authorization')),
      carrier: 'bearer',
      origin: c.req.header('origin'),
    })
    if (grant === null) return c.json({ error: 'unauthorized' }, 401)
    if (grant.kind === 'anonymous' || grant.kind === 'daemon-token') return next()

    // This surface is STRICTER than `/api/*`'s, deliberately, and the
    // difference is the `runtime:read` test rather than the scope check that
    // follows it: a narrow credential reaches only the READ half of
    // `/api/runtime/*`, whatever scopes it holds. Dropping it in favour of
    // `hasRequiredScopes` alone would let a grant holding `runtime:admin`
    // reach the log prune, which the admin routes have never allowed. That is a per-surface policy, so it stays here rather than
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

  // Storage usage report. Cheap stat()-only walk of getDataDir(); nothing is cached.
  // `lastAutoCompactedAt` is the freshest auto-Optimize timestamp across
  // every canvas, so the UI can surface "Auto-optimised Ns ago" without
  // a separate round trip.
  app.get('/api/runtime/storage', async (c) => {
    options.touch()
    const report = await computeStorageReport(getDataDir())
    const lastAutoCompactedAt = await readLatestCompactedAt()
    return c.json({ ...report, lastAutoCompactedAt })
  })

  // Manual override of the daemon-log rotation. The daemon also runs
  // purgeOldDaemonLogs fire-and-forget on every spawn, but exposing this
  // route lets the Storage tab's Logs row show a Cleanup affordance for
  // users who want immediate disk reclamation without restarting.
  //
  // Defense-in-depth on auth: the per-router middleware above also gates
  // this path, but the global daemon-mutation middleware in app.ts
  // explicitly skips /api/runtime/*, so this route is one middleware
  // refactor away from being world-callable. Re-check the bearer in the
  // handler so the file-deletion side effect is never reached without it.
  app.post('/api/runtime/logs/prune', async (c) => {
    // Daemon-token-only, checked against the grant's KIND rather than its
    // scopes: no narrow credential deletes files here, however wide its scope
    // set. Resolved through the same resolver as everything else so there is
    // no second place that compares a secret.
    const grant = await options.credentialResolver.resolve({
      secret: parseBearerAuthorizationHeader(c.req.header('authorization')),
      carrier: 'bearer',
    })
    if (grant?.kind !== 'daemon-token' && grant?.kind !== 'anonymous') {
      return c.json({ error: 'unauthorized' }, 401)
    }
    options.touch()
    const result = await purgeOldDaemonLogs(getDataDir())
    return c.json(result)
  })

  return app
}
