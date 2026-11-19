/**
 * Where a keeper may cut the workspace record's history.
 *
 * A shallow snapshot keeps the ops AFTER its root, so a version stays
 * restorable only when the root is in that version's past. The cut is
 * therefore chosen by causality, never by a version's date: a date is a claim
 * a carried row makes, and the row dated earliest can stand anywhere in the
 * history — at the head, which would drop every other version's past.
 *
 * The cut is the intersection of every version's version vector: per peer,
 * the fewest ops any version has seen. A version is downward-closed in the
 * causal order, so the intersection is too, and lies in every version's past.
 *
 * Over plain version vectors: turning a frontier into one needs the op log, so
 * the keeper that holds it converts the points and the root in, and the cut
 * back out.
 */
import { compareVersions, intersectVersions, type VersionVector } from './version-vector.js'

/**
 * The version every point descends from, or null when there is no cut worth
 * taking: no points, no op every point has seen, or a cut that would fall
 * before the record's existing shallow root (`root`, the version of that root
 * itself — the record can no longer check out anything earlier, so cutting
 * there would export from history it does not hold).
 */
export function compactionCut(
  points: readonly VersionVector[],
  root: VersionVector,
): VersionVector | null {
  const [first, ...rest] = points
  if (first === undefined) return null
  // Meeting `first` with itself drops zero counters, as every other meet does:
  // a lone point is otherwise returned as spelled, and `{peer: 0}` is not empty.
  const common = rest.reduce(intersectVersions, intersectVersions(first, first))
  if (common.size === 0) return null
  const order = compareVersions(common, root)
  return order === 'before' || order === 'concurrent' ? null : common
}
