/**
 * A version as plain data: per peer, how many of its ops have been seen.
 *
 * A history judgement needs only this much of a document's causal state, so it
 * takes the values and not an engine handle — whoever holds the op log
 * converts its frontiers to and from this form. A peer absent from the map has
 * had none of its ops seen, the same as a counter of 0.
 */
export type VersionVector = ReadonlyMap<string, number>

export type VersionOrder = 'before' | 'equal' | 'after' | 'concurrent'

/** How `a` stands to `b` in the causal order. */
export function compareVersions(a: VersionVector, b: VersionVector): VersionOrder {
  let behind = false
  let ahead = false
  for (const peer of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(peer) ?? 0
    const right = b.get(peer) ?? 0
    if (left < right) behind = true
    if (left > right) ahead = true
  }
  if (behind && ahead) return 'concurrent'
  if (behind) return 'before'
  return ahead ? 'after' : 'equal'
}

/**
 * The latest version no later than both: per peer, the fewest ops either has
 * seen. A version is downward-closed in the causal order, so the meet of two
 * is too.
 */
export function intersectVersions(a: VersionVector, b: VersionVector): VersionVector {
  const meet = new Map<string, number>()
  for (const [peer, left] of a) {
    const seen = Math.min(left, b.get(peer) ?? 0)
    if (seen > 0) meet.set(peer, seen)
  }
  return meet
}
