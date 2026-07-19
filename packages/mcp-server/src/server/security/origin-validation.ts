// Neutral per-origin validation rules shared by every allowlist that must
// accept exact HTTPS origins: server-mode's WHITEBOARD_SERVER_ALLOWED_ORIGINS
// and the local-daemon's WHITEBOARD_ALLOWED_WEB_ORIGINS. Kept caller-agnostic
// (no server_mode.* / web_origins.* failure codes here) so each caller can map
// the neutral reason onto its own stable failure-code namespace without this
// module knowing about either.

type OriginValidationFailureReason = 'unparseable' | 'wildcard' | 'not_https' | 'not_origin'

export type OriginValidationResult =
  | { ok: true; origin: string }
  | { ok: false; reason: OriginValidationFailureReason }

// Validates a single configured origin entry and, on success, returns the
// URL-normalised origin (lowercased host, explicit default port dropped) so
// per-request exact-match comparisons always compare canonical forms.
export function validateOriginEntry(value: string): OriginValidationResult {
  if (value === '*') return { ok: false, reason: 'wildcard' }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'not_https' }
  }

  // Origin-only contract: credentials, non-root path, query string, and
  // fragment are all rejected. The raw value is never echoed by callers of
  // this validator so sensitive query/credential data cannot leak into logs.
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return { ok: false, reason: 'not_origin' }
  }

  return { ok: true, origin: parsed.origin }
}
