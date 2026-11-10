import { okfMarkdownFrontmatterSchema } from '@kamiazya/whiteboard-model'
import type { OkfMarkdownDocument } from './schema.js'

const SCHEMA_ORDER: readonly string[] = Object.keys(okfMarkdownFrontmatterSchema.shape)

/**
 * The document with its frontmatter's root keys in the schema's order. The
 * Rust writer refuses any other order, and a caller that builds
 * `{ ...coreFacets, title, ...trust, facets }` has no reason to know that, so
 * the order is settled here, once, before either implementation sees it. A key
 * the schema does not name keeps its relative place after the known ones.
 * Nested values are left as they are: a mapping's own order is its author's.
 */
export function inSchemaOrder(doc: OkfMarkdownDocument): OkfMarkdownDocument {
  const rank = (key: string): number => {
    const at = SCHEMA_ORDER.indexOf(key)
    return at === -1 ? SCHEMA_ORDER.length : at
  }
  const entries = Object.entries(doc.frontmatter)
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry[0]) - rank(b.entry[0]) || a.index - b.index)
    .map(({ entry }) => entry)
  // Object.fromEntries defines own properties, so a `__proto__` key stays data.
  return { ...doc, frontmatter: Object.fromEntries(ordered) as OkfMarkdownDocument['frontmatter'] }
}
