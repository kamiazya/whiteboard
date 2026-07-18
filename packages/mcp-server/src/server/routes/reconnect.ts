// Silent-reconnect surface: lets a previously-paired web origin get a fresh
// daemon Bearer token back after a page reload without a confirmation
// dialog, by proving POSSESSION of a rotating, origin-bound secret rather
// than by presenting the Origin header alone (see web-origin-trust-store.ts
// for why Origin alone would weaken the existing cross-user boundary).
//
// Two routes:
//   POST /api/reconnect-credential — enrollment. Runs behind the app-level
//     daemon-token auth middleware (app.ts), so only a caller who already
//     holds the daemon token (e.g. right after a #wb= pairing) can mint a
//     reconnect secret for its own Origin.
//   POST /api/reconnect-session — the reconnect itself. Deliberately the
//     ONLY unauthenticated-by-daemon-token entry under /api/* (declared
//     `public` in route-scope-registry.ts) because its whole purpose is to
//     hand back a daemon token to a caller who no longer has one. Its own
//     gates (Origin admission + secret possession + non-expired trust
//     record) are what stand in for the app-level auth this route is
//     carved out of.

import { Hono } from 'hono'
import { z } from 'zod'
import { isLoopbackHostname, normalizeOriginHostname } from '../security/cors-loopback.js'
import { isAllowedWebOrigin } from '../security/web-origin-allowlist.js'
import type { WebOriginTrustStore } from '../security/web-origin-trust-store.js'
import { parseBearerAuthorizationHeader } from './auth.js'

export const reconnectCredentialResponseSchema = z.object({
  reconnectSecret: z.string().min(1),
  expiresInDays: z.number().positive(),
})
export type ReconnectCredentialResponse = z.infer<typeof reconnectCredentialResponseSchema>

export const reconnectSessionResponseSchema = z.object({
  token: z.string().min(1),
  reconnectSecret: z.string().min(1),
  expiresInDays: z.number().positive(),
})
export type ReconnectSessionResponse = z.infer<typeof reconnectSessionResponseSchema>

const TRUST_TTL_DAYS = 30

export interface ReconnectRouterOptions {
  trustStore: WebOriginTrustStore
  // Exact-match hosted origins currently admitted, mirroring
  // LocalDaemonAppOptions.allowedWebOrigins. Loopback origins are always
  // admitted in addition to this list (same carve-out as the /api/* CORS
  // middleware) — a hosted origin removed from this list is refused here
  // even if a still-valid trust record exists for it (the delisting path).
  allowedWebOrigins: readonly string[]
  daemonToken: string
}

// Canonicalizes an Origin header the same way WHATWG URL parsing already
// normalizes case and an explicit default port for every other origin
// comparison in this codebase (origin-pattern.ts's matchOrigin relies on the
// same normalization). Returns null for anything unparseable.
function canonicalizeOrigin(originHeader: string | undefined): string | null {
  if (!originHeader) return null
  try {
    return new URL(originHeader).origin
  } catch {
    return null
  }
}

function isAdmittedOrigin(origin: string, allowedWebOrigins: readonly string[]): boolean {
  const hostname = normalizeOriginHostname(origin)
  if (hostname !== null && isLoopbackHostname(hostname)) return true
  return isAllowedWebOrigin(origin, allowedWebOrigins)
}

export function createReconnectRouter(options: ReconnectRouterOptions) {
  const app = new Hono()

  app.post('/api/reconnect-credential', async (c) => {
    const canonicalOrigin = canonicalizeOrigin(c.req.header('origin'))
    if (canonicalOrigin === null || !isAdmittedOrigin(canonicalOrigin, options.allowedWebOrigins)) {
      return c.json({ error: 'forbidden_origin' }, 403)
    }
    const { secret } = await options.trustStore.trustOrigin(canonicalOrigin)
    return c.json(
      reconnectCredentialResponseSchema.parse({
        reconnectSecret: secret,
        expiresInDays: TRUST_TTL_DAYS,
      } satisfies ReconnectCredentialResponse),
    )
  })

  app.post('/api/reconnect-session', async (c) => {
    const canonicalOrigin = canonicalizeOrigin(c.req.header('origin'))
    if (canonicalOrigin === null || !isAdmittedOrigin(canonicalOrigin, options.allowedWebOrigins)) {
      return c.json({ error: 'forbidden_origin' }, 403)
    }
    const presentedSecret = parseBearerAuthorizationHeader(c.req.header('authorization'))
    if (presentedSecret === null) {
      return c.json({ error: 'unauthorized' }, 403)
    }
    const verified = await options.trustStore.verify(canonicalOrigin, presentedSecret)
    if (!verified) {
      return c.json({ error: 'unauthorized' }, 403)
    }
    const { secret: rotatedSecret } = await options.trustStore.rotate(canonicalOrigin)
    return c.json(
      reconnectSessionResponseSchema.parse({
        token: options.daemonToken,
        reconnectSecret: rotatedSecret,
        expiresInDays: TRUST_TTL_DAYS,
      } satisfies ReconnectSessionResponse),
    )
  })

  return app
}
