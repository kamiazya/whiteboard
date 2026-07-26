import { stringify } from 'yaml'
import type { OkfMarkdownDocument } from './schema.js'
import { yamlSafeValueSchema } from './yaml-safe.js'

/**
 * facets-domain keys are emitted in canonical lexicographic order rather
 * than authoring order: readers (including a future View resolver picking
 * "the first matching facet") must get a deterministic answer independent
 * of how the document happened to be typed or generated.
 */
function canonicalizeFacets(
  facets: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (facets === undefined) return undefined
  const sortedKeys = Object.keys(facets).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const canonical: Record<string, unknown> = {}
  for (const key of sortedKeys) canonical[key] = facets[key]
  return canonical
}

export function serializeOkf(doc: OkfMarkdownDocument): string {
  const { facets, ...rest } = doc.frontmatter
  const canonicalFacets = canonicalizeFacets(facets)
  const frontmatter = canonicalFacets === undefined ? rest : { ...rest, facets: canonicalFacets }

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
