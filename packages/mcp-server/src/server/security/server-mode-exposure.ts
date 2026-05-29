// HTTPS external URL / origin / proxy trust boundary contract.
//
// This module defines the pure config-validation contract for local-daemon
// vs server-mode exposure. It does NOT wire auth routes or modify the runtime
// status schema — those are separate slices.
//
// Local-daemon policy (invariant, not negotiable):
//   - Any non-loopback bindHost → rejected, regardless of externalUrl.
//   - publicBaseUrl is always an http loopback origin.
//   - trustedProxy is always false — local daemon never reads proxy headers.
//   - allowedOrigins is the fixed loopback http origin set.
//
// Server-mode policy (for future wiring):
//   - externalUrl is mandatory.
//   - externalUrl must be https:// (http:// rejected; localhost/127.0.0.1/::1
//     are local-daemon dev contracts, not server-mode external URLs).
//   - externalUrl must be origin-only: no username, password, path beyond /,
//     query string, or fragment. Sensitive pieces are never echoed in failure
//     decisions — the code alone reaches the caller.
//   - allowedOrigins must be exact https:// origins; wildcard * is forbidden.
//   - trustedProxy is an explicit opt-in (default false). Proxy header reading
//     in actual routes is a future concern; this flag is the policy record.
//
// Failure codes are stable string identifiers. Problem Details / HTTP route
// wiring is a future concern; the codes are stable so callers can switch on
// them without a flag day.

import { isLoopbackHost } from '../daemon-auth-binding.js'

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

export type ServerModeExposureMode = 'local-daemon' | 'server-mode'

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
  trustedProxy?: boolean
}

export type ServerModeExposureDecision =
  | {
      ok: true
      kind: 'local-loopback'
      publicBaseUrl: string
      allowedOrigins: readonly string[]
      trustedProxy: false
    }
  | {
      ok: true
      kind: 'server-mode'
      publicBaseUrl: string
      allowedOrigins: readonly string[]
      trustedProxy: boolean
    }
  | { ok: false; code: ServerModeExposureFailureCode }

export function resolveServerModeExposure(
  input: ServerModeExposureInput,
): ServerModeExposureDecision {
  if (input.mode === 'local-daemon') {
    // Local-daemon is loopback-only regardless of externalUrl. This mirrors
    // the pre-startup guard in `daemon-auth-binding.ts` so the policy is
    // consistent across both entry points.
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
      trustedProxy: false,
    }
  }

  // server-mode

  if (!input.externalUrl) {
    return { ok: false, code: 'server_mode.external_url_required' }
  }

  let parsed: URL
  try {
    parsed = new URL(input.externalUrl)
  } catch {
    // Unparseable — not a valid https URL.
    return { ok: false, code: 'server_mode.external_url_must_be_https' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, code: 'server_mode.external_url_must_be_https' }
  }

  // Origin-only contract: credentials, non-root path, query string, and
  // fragment are all rejected. The raw URL is never echoed in the failure
  // decision — sensitive query/credential data must not reach operator logs.
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return { ok: false, code: 'server_mode.external_url_must_be_origin' }
  }

  const allowedOrigins = input.allowedOrigins ?? []
  const normalizedOrigins: string[] = []
  for (const origin of allowedOrigins) {
    if (origin === '*') {
      return { ok: false, code: 'server_mode.wildcard_origin_forbidden' }
    }
    let parsedOrigin: URL
    try {
      parsedOrigin = new URL(origin)
    } catch {
      return { ok: false, code: 'server_mode.external_url_must_be_origin' }
    }
    // Same origin-only rules as externalUrl: https required, no
    // credentials/path/query/fragment. The raw origin string is never
    // echoed in the failure decision.
    if (
      parsedOrigin.protocol !== 'https:' ||
      parsedOrigin.username !== '' ||
      parsedOrigin.password !== '' ||
      parsedOrigin.pathname !== '/' ||
      parsedOrigin.search !== '' ||
      parsedOrigin.hash !== ''
    ) {
      return { ok: false, code: 'server_mode.external_url_must_be_origin' }
    }
    // Store the URL-normalised origin (lowercased host, explicit-default port
    // dropped) so the per-request exact-match compares canonical forms. An
    // operator writing `https://Example.com:443` otherwise false-denies the
    // browser's canonical `https://example.com`.
    normalizedOrigins.push(parsedOrigin.origin)
  }

  return {
    ok: true,
    kind: 'server-mode',
    // `URL.origin` normalises scheme + host + port, stripping the trailing
    // slash that `URL.href` would include — consistent with the Origin header
    // format browsers send.
    publicBaseUrl: parsed.origin,
    allowedOrigins: normalizedOrigins,
    trustedProxy: input.trustedProxy ?? false,
  }
}

// Per-request origin allowlist check for server-mode. Config-level validation
// (wildcard rejection, https requirement) happens in `resolveServerModeExposure`;
// this function is the hot-path per-request gate.
export function isOriginAllowedForServerMode(
  requestOrigin: string,
  allowedOrigins: readonly string[],
): boolean {
  return allowedOrigins.includes(requestOrigin)
}
