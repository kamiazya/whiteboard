import { compareCodeUnit } from '@kamiazya/whiteboard-model'
import { Document, Scalar, visit } from 'yaml'
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
      .sort(compareCodeUnit)
      .map((key) => [key, record[key]]),
  )
}

/**
 * The one throw `serializeOkf` makes on purpose: a frontmatter value YAML has
 * no representation for. A distinct class so a caller that wants to refuse
 * THAT — a write, while the author still holds the content — can catch it
 * without also catching a defect in the serialiser, which must stay loud.
 */
export class OkfNotYamlSafeError extends Error {
  constructor(readonly issues: readonly { path: PropertyKey[]; message: string }[]) {
    super(
      `serializeOkf: frontmatter contains a value that is not yaml-safe: ${issues
        .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
        .join('; ')}`,
    )
    this.name = 'OkfNotYamlSafeError'
  }
}

/**
 * Strings `yaml` would write as a block scalar that its own reader, or
 * `parseOkf`, does not give back: a line starting with a tab keeps the tab in
 * its indentation, which the subset refuses; a line of only spaces loses them
 * to the block's indentation. Double quotes spell either with an escape.
 */
const NEEDS_DOUBLE_QUOTES = /(?:^|\n) *\t|(?:^|\n) +\n/

/**
 * YAML for the frontmatter, within the subset `parseOkf` reads.
 *
 * `doubleQuotedAsJSON` because `yaml`'s own double-quoted form breaks a string
 * of 40 or more units across real lines, and mis-writes a space that precedes
 * a line break there (`\\ ` where `\ ` belongs), so the text reads back as a
 * different string. JSON's string syntax is a YAML double-quoted scalar on one
 * line, with no folding to get wrong.
 */
function toYaml(frontmatter: unknown): string {
  const doc = new Document(frontmatter, { aliasDuplicateObjects: false })
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === 'string' && NEEDS_DOUBLE_QUOTES.test(node.value)) {
        node.type = Scalar.QUOTE_DOUBLE
      }
    },
  })
  return doc.toString({ doubleQuotedAsJSON: true })
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
    throw new OkfNotYamlSafeError(safetyCheck.error.issues)
  }

  // Only the newline yaml appends: `trimEnd()` also strips Unicode spaces,
  // and a last value ending in one (U+2000, U+00A0) would lose it and parse
  // back as null. A value held under two keys is written twice rather than
  // as an anchor and alias, which `parseOkf` refuses.
  const yamlText = toYaml(frontmatter).replace(/\r?\n$/, '')
  return `---\n${yamlText}\n---\n${doc.body}`
}
