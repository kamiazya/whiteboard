// The lane's report line, extracted from the runner so it can be tested.
//
// The runner ends in `process.exit`, so nothing in it is importable, and this
// formatter was left inside it once already on the grounds that asserting one
// `join('+')` was not worth restructuring for. What changed that: the line
// carried a BRANCH that dropped a reading the score had computed, and a
// branch is not a formatting nicety — it decides what a reading says.

/**
 * ADR-0033's axis, read beside the other two and never mixed into either:
 * what the board says with APPEARANCE rather than with position. This lane
 * IS that axis's scoreboard — the ADR chose it over an invented corpus,
 * because the drawing corpus has no board that spends the channel and
 * hand-writing one is how a fixture becomes the convention by accident.
 *
 * `constructs` prints always, and `deficit` beside it, because the whole
 * first reading is the RATIO of the two: every board measured so far owes
 * every construct it declares.
 *
 * A board declaring nothing says so — but it does NOT stop there if it SPENT
 * a channel. `contested` on a board with no construct is the axis's sharpest
 * reading, not an empty one: the board draws a distinction and records none,
 * which is the loss ADR-0033 exists to name. This branch used to return
 * early, so that reading was computed on every run and printed on none.
 *
 * A board that declares nothing and spends nothing stays silent, because
 * `colour unused, shape unused` on every undressed board is noise — the
 * undressed board is most of the corpus. Above `constructs > 0` the clause
 * always prints: there `colour unused` beside `shape carried(stencil)` is
 * itself a reading, since it says a second axis has a free channel to use.
 *
 * @param {{ constructs: number, deficit: number, treatments: number, distance: number, overload: number, excess: number, channels?: Record<string, { use: string, carriedBy: readonly string[] }> } | undefined} facets
 */
export function facetLine(facets) {
  if (facets === undefined) return ''
  if (facets.constructs === 0) {
    const spent = Object.values(facets.channels ?? {}).some((r) => r.use !== 'unused')
    return `; facets: declares nothing${spent ? channelClause(facets.channels) : ''}`
  }
  const owed = ['overload', 'excess'].filter((c) => facets[c] > 0).map((c) => `${c} ${facets[c]}`)
  const misuse = owed.length === 0 ? '' : `, ${owed.join(' ')}`
  return `; facets deficit ${facets.deficit}/${facets.constructs}, treatments ${facets.treatments}, distance ${facets.distance}${misuse}${channelClause(facets.channels)}`
}

/**
 * Each channel and WHAT IT CARRIES, by name — `colour carried(ops.status/v0)`
 * rather than a bare `carried`.
 *
 * Printed on the line rather than left to `--out`, because the line is where
 * a reading is actually taken and the name is the whole reason the field
 * exists: `carried` alone cannot separate a board whose colour encodes the
 * declared axis from one whose stencil colour won and left that axis
 * undrawn. Those want opposite repairs and used to print identically.
 */
function channelClause(channels) {
  if (channels === undefined) return ''
  const say = ([name, reading]) =>
    `${name} ${reading.use}${reading.carriedBy.length > 0 ? `(${reading.carriedBy.join('+')})` : ''}`
  return `; ${Object.entries(channels).map(say).join(', ')}`
}
