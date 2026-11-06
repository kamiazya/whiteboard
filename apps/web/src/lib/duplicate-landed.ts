import { parentOfPath } from '@kamiazya/whiteboard-model'

/**
 * Whether a duplicate of `sourcePath` landed, read from the listings before
 * and after it: a path beside the source that was not listed before. A
 * keeper places the copy beside its source, so this is how a page tells a
 * duplicate whose ANSWER was lost from one that wrote nothing — the two
 * refuse identically, and only one of them made a copy.
 */
export function duplicateLanded(
  before: ReadonlySet<string>,
  after: Iterable<string>,
  sourcePath: string,
): boolean {
  const folder = parentOfPath(sourcePath)
  for (const path of after) {
    if (!before.has(path) && parentOfPath(path) === folder) return true
  }
  return false
}
