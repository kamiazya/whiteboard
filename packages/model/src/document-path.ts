/**
 * The two questions every path-keyed store asks about a document subtree:
 * is this path inside that one, and where does it land when that one moves.
 *
 * ONE definition, because the rule is a SEGMENT boundary and every hand-spelled
 * `startsWith(`${root}/`)` is one more place a change to the segment grammar
 * has to be found. A store that re-derived it once already stranded a
 * folder's children while its sibling moved them. Pure and string-only, so it
 * holds in every layer that keys by path — including the ones that cannot
 * reach `ports`.
 */

/**
 * Whether `path` is `ancestor` itself or sits below it. Anchored at a
 * SEGMENT boundary, which is the whole point: `design-system` starts with
 * `design` and is not inside it.
 */
export function isSelfOrDescendant(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}/`)
}

/**
 * Where `path` is once the subtree rooted at `from` has become `to`: `to`
 * for the root itself, `to` plus the remaining segments for anything below
 * it. A path outside the subtree is returned unchanged, so a caller applying
 * a move to every path it tracks need not test membership first.
 */
export function rebasePath(path: string, from: string, to: string): string {
  if (path === from) return to
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path
}

/**
 * What is left of `path` once `folder` is dropped from the front, or
 * `undefined` when `path` is not strictly below it — the folder itself, a
 * sibling that merely shares its prefix, and an ancestor all answer
 * `undefined`. The empty folder is the workspace root, which holds every
 * path whole.
 *
 * The same segment boundary as `isSelfOrDescendant`, handed back as the
 * remainder a caller reads the next segment from, so no caller has to
 * re-derive the prefix and slice it off by length.
 */
export function pathBelow(folder: string, path: string): string | undefined {
  if (folder === '') return path
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : undefined
}
