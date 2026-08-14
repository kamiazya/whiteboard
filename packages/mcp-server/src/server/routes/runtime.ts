import { Hono } from 'hono'
import { purgeOldDaemonLogs } from '../../daemon/log-rotation.js'
import {
  daemonPingResponseSchema,
  runtimeVerifyRequestSchema,
  runtimeVerifyResponseSchema,
} from '../../shared/api-contracts/runtime.js'
import { getDataDir } from '../config.js'
import type { RuntimeStatus } from '../http-server.js'
import { isAuthorized } from '../security/bearer-token.js'
import type { DaemonIdentity } from '../security/daemon-identity.js'
import type { McpHttpAuthStrategy } from '../security/mcp-auth.js'
import type { OAuthTransactionStore } from '../security/oauth-authz-transactions.js'
import { resolveApiRouteScope } from '../security/route-scope-registry.js'
import { readLatestCompactedAt } from '../store/canvas-store.js'
import { isAuthorizedOAuthGrant, isAuthorizedPairingOrigin } from './auth.js'
import { computeStorageReport } from './runtime-storage.js'

// /api/runtime/verify is public and does an Ed25519 sign per call, so cap
// the rate. Loopback traffic makes per-IP buckets meaningless — one global
// sliding window is enough to stop a tight local loop from burning CPU.
const VERIFY_RATE_LIMIT = 60
const VERIFY_RATE_WINDOW_MS = 60_000

export interface RuntimeRouterOptions {
  token?: string
  mcpAuth?: McpHttpAuthStrategy
  instanceId: string
  identity: DaemonIdentity
  touch: () => void
  getStatus: () => RuntimeStatus
  shutdown: () => Promise<void>
  // Scope-limited credentials honored on the READ half of /api/runtime/*
  // (per the route-scope registry). Admin routes (shutdown, touch, logs
  // prune) stay daemon-token-only regardless of these.
  grantStore?: OAuthTransactionStore
  pairingTokens?: { validate(token: string, origin: string): boolean }
}

export function createRuntimeRouter(options: RuntimeRouterOptions) {
  const app = new Hono()

  app.get('/api/runtime/ping', (c) => {
    return c.json(
      daemonPingResponseSchema.parse({
        ok: true,
        instanceId: options.instanceId,
        identity: { alg: options.identity.alg, publicKey: options.identity.publicKey },
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
      return c.json({ error: 'rate limited' }, 429)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    const parsed = runtimeVerifyRequestSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400)
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
    // pairing session token. Admin routes (shutdown, touch, logs prune)
    // accept the daemon token only — a paired web origin can inspect the
    // daemon but never stop it or delete its logs.
    const scope = resolveApiRouteScope(c.req.method, c.req.path)
    if (scope?.kind === 'public') return next()
    if (isAuthorized(c.req.header('authorization'), options.token)) return next()
    if (scope?.kind === 'scoped' && scope.scopes.includes('runtime:read')) {
      if (
        options.grantStore !== undefined &&
        isAuthorizedOAuthGrant(
          c.req.header('authorization'),
          options.grantStore,
          c.req.method,
          c.req.path,
        )
      ) {
        return next()
      }
      if (
        options.pairingTokens !== undefined &&
        isAuthorizedPairingOrigin(
          c.req.header('authorization'),
          c.req.header('origin'),
          options.pairingTokens,
        )
      ) {
        return next()
      }
    }
    return c.json({ error: 'unauthorized' }, 401)
  })

  app.get('/api/runtime/status', (c) => {
    options.touch()
    return c.json(options.getStatus())
  })

  app.post('/api/runtime/touch', (c) => {
    options.touch()
    return c.json({ ok: true })
  })

  app.post('/api/runtime/shutdown', (c) => {
    options.touch()
    setTimeout(() => {
      void options.shutdown()
    }, 0)
    return c.json({ ok: true })
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
    if (!isAuthorized(c.req.header('authorization'), options.token)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    options.touch()
    const result = await purgeOldDaemonLogs(getDataDir())
    return c.json(result)
  })

  return app
}
