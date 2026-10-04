// HTTPS external URL / origin / proxy trust boundary contract.
//
// This module defines the pure config-validation contract for local-daemon
// vs server-mode exposure. It does NOT wire auth routes or modify the runtime
// status schema — those are separate slices.
//
// Local-daemon policy (invariant, not negotiable):
//   - Any non-loopback bindHost → rejected, regardless of externalUrl.
//   - publicBaseUrl is always an http loopback origin.
//   - allowedOrigins is the fixed loopback http origin set.
//
// Server-mode policy (for future wiring):
//   - externalUrl is mandatory.
//   - externalUrl must be https:// (http:// rejected; localhost/127.0.0.1/::1
//     are local-daemon dev contracts, not server-mode external URLs).
//   - externalUrl must be origin-only: no username, password, path beyond /,
//     query string, or fragment. Sensitive pieces are never echoed in failure
//     decisions — the code alone reaches the caller.
//   - allowedOrigins must be exact https:// origins or leftmost-label
//     wildcard subdomain patterns (https://*.example.com); bare '*' is
//     forbidden (see origin-pattern.ts for the full matching contract).
//
// Failure codes are stable string identifiers. Problem Details / HTTP route
// wiring is a future concern; the codes are stable so callers can switch on
// them without a flag day.

import { isLoopbackHost } from '../../shared/loopback-host.js'
import { canonicalizeOriginPatternEntry, parseOriginPatternEntry } from './origin-pattern.js'
import { validateOriginEntry } from './origin-validation.js'

function bracketIpv6(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

// The set of http loopback origins the local-daemon CORS surface accepts.
// All three variants are listed because browser Origin headers can carry any
// of them depending on how the user navigated to the app (IPv4, name, IPv6).
const LOCAL_DAEMON_ALLOWED_ORIGINS: readonly string[] = [
  'http://127.0.0.1',
  'http://localhost',
  'http://[::1]',
]

type ServerModeExposureMode = 'local-daemon' | 'server-mode'

export type ServerModeExposureFailureCode =
  | 'local_daemon.non_loopback_forbidden'
  | 'server_mode.external_url_required'
  | 'server_mode.external_url_must_be_https'
  | 'server_mode.external_url_must_be_origin'
  | 'server_mode.wildcard_origin_forbidden'
  | 'server_mode.origin_not_allowed'

export interface ServerModeExposureInput {
  mode: ServerModeExposureMode
  bindHost: string
  externalUrl?: string
  allowedOrigins?: readonly string[]
}

export type ServerModeExposureDecision =
  | {
      ok: true
      kind: 'local-loopback'
      publicBaseUrl: string
      allowedOrigins: readonly string[]
    }
  | {
      ok: true
      kind: 'server-mode'
      publicBaseUrl: string
      allowedOrigins: readonly string[]
    }
  | { ok: false; code: ServerModeExposureFailureCode }

export function resolveServerModeExposure(
  input: ServerModeExposureInput,
): ServerModeExposureDecision {
  return input.mode === 'local-daemon' ? localDaemonExposure(input) : serverModeExposure(input)
}

/**
 * Local-daemon is loopback-only regardless of externalUrl, by the same
 * `isLoopbackHost` the database location reads, so the policy is consistent
 * across both entry points.
 */
function localDaemonExposure(input: ServerModeExposureInput): ServerModeExposureDecision {
  if (!isLoopbackHost(input.bindHost)) {
    return { ok: false, code: 'local_daemon.non_loopback_forbidden' }
  }
  return {
    ok: true,
    kind: 'local-loopback',
    // Bare IPv6 literals (e.g. ::1) are not valid in a URL host — they
    // require brackets. Bracketed form ([::1]) and non-IPv6 hosts are
    // left unchanged.
    publicBaseUrl: `http://${bracketIpv6(input.bindHost)}`,
    allowedOrigins: LOCAL_DAEMON_ALLOWED_ORIGINS,
  }
}

/** The https origin the deployment is reached at, or why it is refused. */
function externalOrigin(
  externalUrl: string | undefined,
): { ok: true; origin: string } | ServerModeExposureDecision {
  if (!externalUrl) return { ok: false, code: 'server_mode.external_url_required' }
  // The failure decision never echoes the raw URL — sensitive query/credential
  // data must not reach operator logs.
  const result = validateOriginEntry(externalUrl)
  if (result.ok) return { ok: true, origin: result.origin }
  return {
    ok: false,
    code:
      result.reason === 'not_origin'
        ? 'server_mode.external_url_must_be_origin'
        : 'server_mode.external_url_must_be_https',
  }
}

/**
 * Same origin-only rules as externalUrl (https required, no
 * credentials/path/query/fragment) via the shared pattern parser — entries may
 * be exact origins or leftmost-label wildcard subdomain patterns (see
 * origin-pattern.ts). The neutral reason is mapped back onto this module's own
 * failure-code namespace so existing callers see byte-identical codes. The raw
 * origin string is never echoed in the failure decision. Storing the
 * canonicalized entry string (rather than `new URL(origin).origin`) matters
 * here: `new URL('https://*.example.com')` does not throw, so a naive
 * normalization would silently keep the wildcard as an inert literal string
 * that the per-request matcher (server-mode-middleware) must still be able to
 * re-parse back into a pattern.
 */
function normalizedAllowedOrigins(
  allowedOrigins: readonly string[],
): { ok: true; origins: string[] } | ServerModeExposureDecision {
  const normalizedOrigins: string[] = []
  for (const origin of allowedOrigins) {
    const result = parseOriginPatternEntry(origin)
    if (!result.ok) {
      return {
        ok: false,
        code:
          result.reason === 'wildcard'
            ? 'server_mode.wildcard_origin_forbidden'
            : 'server_mode.external_url_must_be_origin',
      }
    }
    normalizedOrigins.push(canonicalizeOriginPatternEntry(origin))
  }
  return { ok: true, origins: normalizedOrigins }
}

function serverModeExposure(input: ServerModeExposureInput): ServerModeExposureDecision {
  const external = externalOrigin(input.externalUrl)
  if (!('origin' in external)) return external

  const normalized = normalizedAllowedOrigins(input.allowedOrigins ?? [])
  if (!('origins' in normalized)) return normalized
  const normalizedOrigins = normalized.origins

  return {
    ok: true,
    kind: 'server-mode',
    // The validator's origin normalises scheme + host + port with no trailing
    // slash — consistent with the Origin header format browsers send.
    publicBaseUrl: external.origin,
    allowedOrigins: normalizedOrigins,
  }
}
