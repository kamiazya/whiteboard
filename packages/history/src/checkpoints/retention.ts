/**
 * Which automatic checkpoints a keeper may let go, decided over its rows.
 *
 * Two passes, both pure: a keeper fetches the rows, asks, and deletes what
 * it is told — the row fetch, the delete and any thumbnail blob are its own.
 *
 * A checkpoint is disposable in a way a manual save is not, and lineage is
 * not disposable at all: a restore records its merge point as an automatic
 * version, so without the exemption both ENDS of a restore are ordinary
 * sweep candidates — the merge itself, and the point it named. Losing either
 * leaves a history that once explained where a state came from and no longer
 * can, and unlike a swept checkpoint that is not recoverable by editing again.
 */

/** The most automatic checkpoints a document keeps, before the oldest go. */
export const MAX_AUTO_PER_DOCUMENT = 50

export interface CapCandidate {
  readonly id: string
  /** The version this one restored, when it is a restore's merge point. */
  readonly restoredFrom: string | null
}

/**
 * The automatic checkpoints past the cap that may be removed.
 *
 * `autosNewestFirst` is every automatic row of the document, newest first;
 * `referenced` is every id some row names as `restoredFrom`. Lineage outlives
 * the cap on both ends: a merge point is kept, and so is the point it named.
 * A merge is rare, so the cap it stretches is stretched by very little.
 */
export function autoVersionsOverCap(
  autosNewestFirst: readonly CapCandidate[],
  referenced: ReadonlySet<string>,
  cap: number = MAX_AUTO_PER_DOCUMENT,
): string[] {
  if (autosNewestFirst.length <= cap) return []
  return autosNewestFirst
    .slice(cap)
    .filter((r) => r.restoredFrom === null && !referenced.has(r.id))
    .map((r) => r.id)
}

export interface SandwichCandidate {
  readonly id: string
  readonly branchName: string
  readonly auto: boolean
}

/**
 * The automatic checkpoints strictly BETWEEN a branch's first and last
 * manual save — the sandwich a person's own saves already bracket, where an
 * automatic one adds a row and no information.
 *
 * `rows` are every row of the document in the order they are kept
 * (branch, then time, then id). A branch with fewer than two manual saves
 * has no sandwich and is left alone.
 */
export function sandwichedAutoVersionIds(rows: readonly SandwichCandidate[]): string[] {
  const byBranch = new Map<string, SandwichCandidate[]>()
  for (const row of rows) {
    const list = byBranch.get(row.branchName) ?? []
    list.push(row)
    byBranch.set(row.branchName, list)
  }
  return [...byBranch.values()].flatMap(sandwichedIn)
}

/** One branch's sandwiched automatic rows, in keeping order. */
function sandwichedIn(list: readonly SandwichCandidate[]): string[] {
  const manual = list.flatMap((row, i) => (row.auto ? [] : [i]))
  const first = manual[0]
  const last = manual.at(-1)
  if (first === undefined || last === undefined) return []
  return list
    .slice(first + 1, last)
    .filter((row) => row.auto)
    .map((row) => row.id)
}
