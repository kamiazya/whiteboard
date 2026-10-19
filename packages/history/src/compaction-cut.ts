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
 */
import { type Frontiers, type LoroDoc, type PeerID, VersionVector } from 'loro-crdt'

/**
 * The frontiers every point descends from, or null when there is no cut worth
 * taking: no points, a point the record does not hold, no op every point has
 * seen, or a cut that would fall before the record's existing shallow root.
 */
export function compactionCut(doc: LoroDoc, points: readonly Frontiers[]): Frontiers | null {
  let common: Map<PeerID, number> | null = null
  for (const point of points) {
    let seen: Map<PeerID, number>
    try {
      seen = doc.frontiersToVV(point).toJSON()
    } catch {
      return null
    }
    if (common === null) {
      common = seen
      continue
    }
    const next = new Map<PeerID, number>()
    for (const [peer, end] of common) {
      const other = seen.get(peer)
      if (other !== undefined) next.set(peer, Math.min(end, other))
    }
    common = next
  }
  if (common === null || common.size === 0) return null
  const cut = VersionVector.parseJSON(common)
  // `frontiersToVV` answers for a point before the shallow root too, though
  // the record can no longer check one out; cutting there would export from
  // history the record does not hold.
  // The root's own vector, not `shallowSinceVV()`: that one stops one op
  // short of the root, so a cut one op before the root compared equal to it.
  const root = doc.frontiersToVV(doc.shallowSinceFrontiers())
  const order = cut.compare(root)
  if (order === undefined || order < 0) return null
  return doc.vvToFrontiers(cut)
}
