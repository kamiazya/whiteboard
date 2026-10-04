// Neutral per-origin validation rules for an allowlist that must accept
// exact HTTPS origins (server-mode's WHITEBOARD_SERVER_ALLOWED_ORIGINS). Kept
// caller-agnostic (no server_mode.* failure codes here) so a caller maps the
// neutral reason onto its own stable failure-code namespace.

type OriginValidationFailureReason = 'unparseable' | 'wildcard' | 'not_https' | 'not_origin'

export type OriginValidationResult =
  | { ok: true; origin: string }
  | { ok: false; reason: OriginValidationFailureReason }

// The origin-only https predicate every origin-shaped input is held to: https
// scheme; no credentials, non-root path, query string or fragment. The raw
// value is never echoed by callers, so sensitive query/credential data cannot
// leak into logs. Returns the parsed URL so a caller can read further parts
// (the wildcard parser reads the host) without parsing twice.
export function parseHttpsOrigin(
  value: string,
): { ok: true; parsed: URL } | { ok: false; reason: 'unparseable' | 'not_https' | 'not_origin' } {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'not_https' }
  }

  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return { ok: false, reason: 'not_origin' }
  }

  return { ok: true, parsed }
}

// Validates a single configured origin entry and, on success, returns the
// URL-normalised origin (lowercased host, explicit default port dropped) so
// per-request exact-match comparisons always compare canonical forms.
export function validateOriginEntry(value: string): OriginValidationResult {
  if (value === '*') return { ok: false, reason: 'wildcard' }

  const result = parseHttpsOrigin(value)
  if (!result.ok) return result
  return { ok: true, origin: result.parsed.origin }
}
