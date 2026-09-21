// The prelude itself is `@kamiazya/whiteboard-model/test-utils`, written
// once; this file exists so the test files importing it do not have to
// change and so a package-local addition still has somewhere to go — which
// here is `hasNoEmptyContainer`, below.
export { fc, fcTest, withDefaults } from '@kamiazya/whiteboard-model/test-utils'

/**
 * Rejects a generated mdast tree containing any container node (one with a
 * `children` array) that is empty. An empty container (e.g. a paragraph or
 * list item with zero children) stringifies to nothing and a re-parse
 * simply omits it — real information loss for a genuinely contentless node,
 * not a normalizeMdast/codec bug, and in at least one combination (an empty
 * paragraph as the first child of a checked list item) serializes to
 * malformed markdown that a downstream remark plugin cannot re-parse at
 * all. Shared by every property in this package that generates arbitrary
 * mdast trees, so the exclusion is defined once.
 */
export function hasNoEmptyContainer(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return true
  const record = node as { children?: unknown }
  if (Array.isArray(record.children)) {
    if (record.children.length === 0) return false
    return record.children.every(hasNoEmptyContainer)
  }
  return true
}
