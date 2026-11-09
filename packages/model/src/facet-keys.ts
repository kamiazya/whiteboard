/**
 * Root-level frontmatter keys that are NOT free for `facetsRaw` to preserve:
 * the core facet fields, the `facets` extension bucket itself, and the OKF
 * v0.2 trust family (`trust.ts`), which this codebase models rather than
 * merely carrying. Keeping this list exported means both `coreFacetsSchema`
 * consumers and `facetsRawSchema` share one definition of "reserved", so a
 * key can never legally live in two buckets at once.
 *
 * A key joins this list the moment something INTERPRETS it. Until then
 * `facetsRaw` is the right home: preserved verbatim, and never
 * half-understood.
 */
export const RESERVED_ROOT_KEYS = [
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'view',
  'facets',
  'generated',
  'verified',
] as const

/**
 * The key grammar of an extension facet, `{namespace}.{name}/v{n}` (ADR-0013).
 * Held apart from `facets.ts` because the generated schemas' checks read it,
 * and `facets.ts` imports those schemas.
 */
export const EXTENSION_FACET_KEY_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/v[0-9]+$/
