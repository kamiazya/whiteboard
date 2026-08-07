// Single source of truth for the local-daemon's hosted-origin admission
// contract: parses WHITEBOARD_ALLOWED_WEB_ORIGINS and exposes the one
// predicate every surface (/api CORS, /mcp origin gate, WS upgrade) must use
// so origin matching cannot drift between them. Entries are exact https
// origins OR leftmost-label wildcard subdomain patterns (see
// origin-pattern.ts for the full matching contract); bare '*' stays
// rejected (ADR-0002 addendum, amended to admit the narrower wildcard shape).
//
// This env var governs local-daemon mode only. Server-mode reads
// WHITEBOARD_SERVER_ALLOWED_ORIGINS via server-mode-exposure.ts and never
// consults this module.

import { getLogger } from '../log.js'
import {
  canonicalizeOriginPatternEntry,
  matchOrigin,
  type OriginPatternFailureReason,
  parseOriginPatternEntry,
  parseOriginPatterns,
} from './origin-pattern.js'

type WebOriginsFailureCode =
  | 'web_origins.entry_must_be_https'
  | 'web_origins.entry_must_be_origin'
  | 'web_origins.wildcard_forbidden'
  | 'web_origins.entry_unparseable'
  | 'web_origins.invalid_wildcard_pattern'

const REASON_TO_CODE: Record<OriginPatternFailureReason, WebOriginsFailureCode> = {
  unparseable: 'web_origins.entry_unparseable',
  wildcard: 'web_origins.wildcard_forbidden',
  not_https: 'web_origins.entry_must_be_https',
  not_origin: 'web_origins.entry_must_be_origin',
  wildcard_not_leftmost: 'web_origins.invalid_wildcard_pattern',
  wildcard_multi_label: 'web_origins.invalid_wildcard_pattern',
  wildcard_suffix_too_short: 'web_origins.invalid_wildcard_pattern',
  wildcard_ip_suffix: 'web_origins.invalid_wildcard_pattern',
}

export type ParseAllowedWebOriginsResult =
  | { ok: true; origins: readonly string[] }
  | { ok: false; code: WebOriginsFailureCode; entryIndex: number }

// Parses the raw WHITEBOARD_ALLOWED_WEB_ORIGINS env value: comma-separated
// exact HTTPS origins. Unset/empty is a valid, empty allowlist (byte-identical
// current loopback-only behavior). A malformed entry fails fast with its
// index rather than being silently dropped.
export function parseAllowedWebOriginsEnv(value: string | undefined): ParseAllowedWebOriginsResult {
  if (!value || value.trim() === '') return { ok: true, origins: [] }

  // Iterate the raw split so a reported entryIndex points at the true position
  // in the operator's comma-separated value; empty/whitespace entries are
  // skipped in-loop rather than filtered out first (which would shift indices).
  const entries = value.split(',')
  const origins: string[] = []
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex].trim()
    if (entry.length === 0) continue
    const result = parseOriginPatternEntry(entry)
    if (!result.ok) {
      return { ok: false, code: REASON_TO_CODE[result.reason], entryIndex }
    }
    origins.push(canonicalizeOriginPatternEntry(entry))
  }
  return { ok: true, origins }
}

// Per-request admission predicate shared by /api CORS, /mcp origin gate, and
// WS upgrade. Each allowlist entry (already validated by
// parseAllowedWebOriginsEnv) is parsed into an OriginPattern and matched
// via the shared matcher, which normalizes the request Origin header's case,
// IDN form, and default port identically to the pattern side.
//
// The allowlist array is parsed once at startup and reused by reference for
// every request, so the compiled patterns are cached per array identity —
// re-parsing on every CORS/mcp/WS request would be pure waste on a hot path.
const compiledAllowlists = new WeakMap<readonly string[], ReturnType<typeof parseOriginPatterns>>()

function compiledPatternsFor(allowlist: readonly string[]): ReturnType<typeof parseOriginPatterns> {
  const cached = compiledAllowlists.get(allowlist)
  if (cached) return cached
  const patterns = parseOriginPatterns(allowlist)
  compiledAllowlists.set(allowlist, patterns)
  return patterns
}

export function isAllowedWebOrigin(
  originHeader: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (!originHeader || allowlist.length === 0) return false
  return matchOrigin(compiledPatternsFor(allowlist), originHeader)
}

// Startup-time wiring helper shared by both entrypoints (cli/daemon-run.ts,
// server/index.ts): parses the env once and logs a structured failure record
// (never echoing the raw offending value) instead of each entrypoint
// re-implementing the parse-and-log seam.
export function loadAllowedWebOriginsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] | null {
  const result = parseAllowedWebOriginsEnv(env.WHITEBOARD_ALLOWED_WEB_ORIGINS)
  if (!result.ok) {
    const log = getLogger('web-origin-allowlist')
    log.error(
      { code: result.code, entryIndex: result.entryIndex },
      'invalid WHITEBOARD_ALLOWED_WEB_ORIGINS entry',
    )
    return null
  }
  return result.origins
}

// A static allowlist (env-derived, fixed for the process) or a PROVIDER
// re-evaluated per request. The provider form exists for pairing grants:
// an origin approved at runtime must take effect on every origin-checking
// surface (/api CORS, /mcp origin, WS upgrade) without a restart, and each
// generation must be a NEW array so the pattern cache above keys correctly.
export type AllowedWebOrigins = readonly string[] | (() => readonly string[])

export function resolveAllowedWebOrigins(value: AllowedWebOrigins | undefined): readonly string[] {
  if (value === undefined) return []
  return typeof value === 'function' ? value() : value
}
