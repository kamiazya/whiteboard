import { stringify } from 'yaml'
import type { OkfMarkdownDocument } from './schema.js'
import { yamlSafeValueSchema } from './yaml-safe.js'

/**
 * Emits a record's keys in canonical lexicographic order rather than
 * authoring order, for both frontmatter buckets that hold producer-chosen
 * keys:
 *
 * - `facets`, because a reader (including a future View resolver picking
 *   "the first matching facet") must get a deterministic answer independent
 *   of how the document happened to be typed or generated.
 * - `facetsRaw`, because its keys survive a trip through the Loro store as
 *   one map value and come back in whatever order that yields, so authoring
 *   order is not preserved end-to-end and only a canonical order is stable.
 *
 * Built with `Object.fromEntries` rather than an assignment loop: a
 * producer-authored `__proto__` key would otherwise reach the prototype
 * setter instead of becoming an own property.
 */
function canonicalize(
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (record === undefined) return undefined
  return Object.fromEntries(
    Object.keys(record)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => [key, record[key]]),
  )
}

export function serializeOkf(doc: OkfMarkdownDocument): string {
  const { facets, facetsRaw, ...rest } = doc.frontmatter
  const canonicalFacets = canonicalize(facets)
  // Preserved keys are spread back at the ROOT they came from (OKF §4.1) —
  // emitting the bucket itself would publish `facetsRaw:` as a frontmatter
  // key OKF gives no meaning to, and make the round trip nest one level
  // deeper on every pass.
  const frontmatter = {
    ...rest,
    ...canonicalize(facetsRaw),
    ...(canonicalFacets === undefined ? {} : { facets: canonicalFacets }),
  }

  const safetyCheck = yamlSafeValueSchema.safeParse(frontmatter)
  if (!safetyCheck.success) {
    throw new Error(
      `serializeOkf: frontmatter contains a value that is not yaml-safe: ${safetyCheck.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    )
  }

  const yamlText = stringify(frontmatter).trimEnd()
  return `---\n${yamlText}\n---\n${doc.body}`
}
