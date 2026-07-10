// Single source of truth for the local-daemon's hosted-origin admission
// contract: parses WHITEBOARD_ALLOWED_WEB_ORIGINS and exposes the one
// predicate every surface (/api CORS, /mcp origin gate, WS upgrade) must use
// so origin matching cannot drift between them. Exact-match only — wildcard
// and suffix matching are never introduced here (ADR-0002 addendum).
//
// This env var governs local-daemon mode only. Server-mode reads
// WHITEBOARD_SERVER_ALLOWED_ORIGINS via server-mode-exposure.ts and never
// consults this module.

import { getLogger } from '../log.js'
import { validateOriginEntry, type OriginValidationFailureReason } from './origin-validation.js'

export type WebOriginsFailureCode =
  | 'web_origins.entry_must_be_https'
  | 'web_origins.entry_must_be_origin'
  | 'web_origins.wildcard_forbidden'
  | 'web_origins.entry_unparseable'

const REASON_TO_CODE: Record<OriginValidationFailureReason, WebOriginsFailureCode> = {
  unparseable: 'web_origins.entry_unparseable',
  wildcard: 'web_origins.wildcard_forbidden',
  not_https: 'web_origins.entry_must_be_https',
  not_origin: 'web_origins.entry_must_be_origin',
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

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const origins: string[] = []
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const result = validateOriginEntry(entries[entryIndex])
    if (!result.ok) {
      return { ok: false, code: REASON_TO_CODE[result.reason], entryIndex }
    }
    origins.push(result.origin)
  }
  return { ok: true, origins }
}

// Per-request exact-match predicate shared by /api CORS, /mcp origin gate,
// and WS upgrade. Normalises the request Origin header through URL.origin so
// host case and default-port variants compare canonically against the
// already-normalised allowlist produced by parseAllowedWebOriginsEnv.
export function isAllowedWebOrigin(
  originHeader: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (!originHeader || allowlist.length === 0) return false
  try {
    return allowlist.includes(new URL(originHeader).origin)
  } catch {
    return false
  }
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
