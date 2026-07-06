// Host-header guard for /api/* — the DNS-rebinding backstop that the CORS
// middleware alone does not provide (CORS only governs which cross-origin
// responses a browser will hand to script; it never blocks the request from
// reaching the handler). Takes the exposure mode as a function-boundary
// argument so wiring server-mode's origin-allowlist policy here later is a
// local change, not a new call site.

import type { MiddlewareHandler } from 'hono'
import type { ServerModeExposureMode } from './server-mode-exposure.js'
import { getRequestHost, isLoopbackHostname, normalizeHostHeader } from './cors-loopback.js'

export function createApiHostGuardMiddleware(mode: ServerModeExposureMode): MiddlewareHandler {
  return async (c, next) => {
    if (mode === 'server-mode') return next()

    const host = normalizeHostHeader(getRequestHost(c))
    if (!host || !isLoopbackHostname(host)) {
      return Response.json({ error: 'forbidden host' }, { status: 403 })
    }
    return next()
  }
}
