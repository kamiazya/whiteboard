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

/**
 * The most manual versions a document keeps. A manual save is a person's
 * save-point and is never retired, so this is a CEILING a keeper refuses a
 * save past, not a cap it prunes to. Bounded at all because every saved
 * point is walked by file collection and listed by the history panel, and a
 * caller in a loop could otherwise grow both without end. Four times the
 * automatic cap: room for a save-point at every step of a long piece of work.
 */
export const MAX_MANUAL_PER_DOCUMENT = 4 * MAX_AUTO_PER_DOCUMENT

/** A row as lineage sees it: its id, and the version it restored, if any. */
export interface LineageCandidate {
  readonly id: string
  /** The version this one restored, when it is a restore's merge point. */
  readonly restoredFrom: string | null
}

/**
 * Whether a row is lineage, which neither pass may take: a restore's merge
 * point, or a point some merge names. `referenced` is every id some row of
 * the document names as `restoredFrom`.
 */
function isLineage(row: LineageCandidate, referenced: ReadonlySet<string>): boolean {
  return row.restoredFrom !== null || referenced.has(row.id)
}

/**
 * The options a keeper saves a restore's merge point with. Automatic, because
 * the system recorded it rather than a person asking for it — and lineage, so
 * neither retention pass may take it.
 */
export function restorePointOptions(restoredFrom: string): {
  readonly auto: true
  readonly restoredFrom: string
} {
  return { auto: true, restoredFrom }
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
  autosNewestFirst: readonly LineageCandidate[],
  referenced: ReadonlySet<string>,
  cap: number = MAX_AUTO_PER_DOCUMENT,
): string[] {
  if (autosNewestFirst.length <= cap) return []
  return autosNewestFirst
    .slice(cap)
    .filter((r) => !isLineage(r, referenced))
    .map((r) => r.id)
}

export interface SandwichCandidate extends LineageCandidate {
  readonly auto: boolean
}

/**
 * The automatic checkpoints strictly BETWEEN a document's first and last
 * manual save — the sandwich a person's own saves already bracket, where an
 * automatic one adds a row and no information. Lineage is spared here as in
 * the cap pass; `rows` being the whole document, the ids merges name are read
 * from them.
 *
 * `rows` are every row of the document in the order they are kept (time,
 * then id). A document with fewer than two manual saves has no sandwich and
 * is left alone.
 */
export function sandwichedAutoVersionIds(rows: readonly SandwichCandidate[]): string[] {
  const manual = rows.flatMap((row, i) => (row.auto ? [] : [i]))
  const first = manual[0]
  const last = manual.at(-1)
  if (first === undefined || last === undefined) return []
  const referenced = new Set(
    rows.flatMap((row) => (row.restoredFrom === null ? [] : [row.restoredFrom])),
  )
  return rows
    .slice(first + 1, last)
    .filter((row) => row.auto && !isLineage(row, referenced))
    .map((row) => row.id)
}
