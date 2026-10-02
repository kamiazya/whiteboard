/**
 * An ISO 8601 datetime with an offset, as the diagnostics bundle accepts one.
 *
 * Matches the shape Zod's `.datetime({ offset: true })` accepts (milliseconds
 * optional; offset `Z` or `±HH:MM`) without a round-trip through Zod for every
 * emitted log entry. A timestamp is a structural field here, so tolerating an
 * arbitrary string would let a caller carry an Authorization header, a path
 * or a stack frame into the bundle verbatim; the regex alone passes
 * `2026-13-40T…`, so the date must also parse.
 */
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export function isIsoDatetime(value: string): boolean {
  return ISO_DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value))
}
