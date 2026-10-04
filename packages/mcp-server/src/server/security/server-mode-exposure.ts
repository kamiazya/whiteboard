// What an operator's deployment config says about where the server is reached.
//
// Validates the two origin-bearing settings and answers either the origin set
// the deployment serves or a stable failure code:
//   - externalUrl is mandatory and must be an https origin: no username,
//     password, path beyond /, query string or fragment. Sensitive pieces are
//     never echoed in a failure decision — the code alone reaches the caller.
//   - allowedOrigins entries must be exact https origins or leftmost-label
//     wildcard subdomain patterns (https://*.example.com); bare '*' is
//     forbidden (see origin-pattern.ts for the matching contract).
//
// Accepted allowedOrigins are returned in the canonical entry form
// `canonicalizeOriginPatternEntry` produces (default ports and host case
// normalised, a wildcard kept as a pattern), so the per-request matcher in
// server-mode-middleware compares like with like. `new URL(entry).origin` is
// not a substitute: it parses a wildcard entry without throwing and would keep
// it as an inert literal.
//
// Failure codes are stable string identifiers callers can switch on.

import { canonicalizeOriginPatternEntry, parseOriginPatternEntry } from './origin-pattern.js'
import { validateOriginEntry } from './origin-validation.js'

type ServerModeExposureFailureCode =
  | 'server_mode.external_url_required'
  | 'server_mode.external_url_must_be_https'
  | 'server_mode.external_url_must_be_origin'
  | 'server_mode.wildcard_origin_forbidden'

interface ServerModeExposureInput {
  externalUrl?: string
  allowedOrigins?: readonly string[]
}

export type ServerModeExposureDecision =
  | { ok: true; publicBaseUrl: string; allowedOrigins: readonly string[] }
  | { ok: false; code: ServerModeExposureFailureCode }

/** The https origin the deployment is reached at, or why it is refused. */
function externalOrigin(
  externalUrl: string | undefined,
): { ok: true; origin: string } | Extract<ServerModeExposureDecision, { ok: false }> {
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
 * The same origin-only rules as externalUrl through the shared pattern parser;
 * its neutral reason is mapped onto this module's own failure codes. The raw
 * entry is never echoed in the failure decision.
 */
function canonicalAllowedOrigins(
  allowedOrigins: readonly string[],
): { ok: true; origins: string[] } | Extract<ServerModeExposureDecision, { ok: false }> {
  const origins: string[] = []
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
    origins.push(canonicalizeOriginPatternEntry(origin))
  }
  return { ok: true, origins }
}

export function resolveServerModeExposure(
  input: ServerModeExposureInput,
): ServerModeExposureDecision {
  const external = externalOrigin(input.externalUrl)
  if (!external.ok) return external

  const allowed = canonicalAllowedOrigins(input.allowedOrigins ?? [])
  if (!allowed.ok) return allowed

  return {
    ok: true,
    // The validator's origin normalises scheme + host + port with no trailing
    // slash — consistent with the Origin header format browsers send.
    publicBaseUrl: external.origin,
    allowedOrigins: allowed.origins,
  }
}
