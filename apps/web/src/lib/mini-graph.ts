// Build the dot-and-connector data for the 32px lane at the left edge of VersionTimeline.
// Per Spec §9 in the design canvas, each version row gets a centered dot and rows are joined
// by a vertical connector.
// `branchOut` marks the version where another branch split off.
//
// UX rules:
// - rows on the active HEAD branch use a solid dot
// - rows on other branches use a ring dot
// - row colors reuse BranchMeta.color
// - unknown branches fall back to neutral gray

interface MiniGraphBranch {
  name: string
  color: string
  baseBranch?: string
  baseVersionId?: string
}

interface MiniGraphVersion {
  id: string
  branchName: string
  createdAt: string
  /** Set when this point is the merge a restore produced. */
  restoredFrom?: string
}

export interface MiniGraphInput {
  head: string
  branches: MiniGraphBranch[]
  versions: MiniGraphVersion[]
}

export interface MiniGraphRow {
  versionId: string
  dotColor: string
  active: boolean
  connectorBefore: boolean
  branchOut?: string
  /**
   * The row this one was restored FROM, when that row is still listed — the
   * far end of the arc to draw. A restore is a merge, so this is the second
   * parent; the trunk above and below is the first.
   *
   * Absent when the source has been pruned away, which is an ordinary
   * outcome rather than an error: an automatic checkpoint can be swept while
   * the merge that named it stays, and an arc to nowhere is worse than no
   * arc.
   */
  restoredFrom?: string
  /** How many rows down the arc reaches, so the drawing can size itself. */
  restoredFromDistance?: number
  /** An arc from somewhere above lands on this row. */
  isRestoreSource: boolean
  /**
   * An arc passes THROUGH this row on its way between a merge and its
   * source.
   *
   * The lane is drawn one row at a time — each row paints its own 36px of
   * it — so a span longer than one row only joins up if the rows in the
   * middle paint their piece. Without this a long arc is two disconnected
   * hooks.
   */
  isRestoreArcThrough: boolean
}

const FALLBACK_COLOR = '#94a3b8' // slate-400

export function buildMiniGraph(input: MiniGraphInput): MiniGraphRow[] {
  const branchByName = new Map<string, MiniGraphBranch>()
  for (const b of input.branches) branchByName.set(b.name, b)

  // Attach branchOut labels to the version referenced by baseVersionId.
  // If multiple branches split from the same version, join their names with commas.
  const branchOutByVersionId = new Map<string, string[]>()
  for (const b of input.branches) {
    if (!b.baseVersionId) continue
    const existing = branchOutByVersionId.get(b.baseVersionId) ?? []
    existing.push(b.name)
    branchOutByVersionId.set(b.baseVersionId, existing)
  }

  // Newest first, as the panel lists them, so a version's own position is
  // what an arc's length is measured against.
  const indexById = new Map(input.versions.map((v, i) => [v.id, i]))

  const rows: MiniGraphRow[] = []
  for (let i = 0; i < input.versions.length; i++) {
    const v = input.versions[i]!
    const branch = branchByName.get(v.branchName)
    const active = v.branchName === input.head
    const labels = branchOutByVersionId.get(v.id)
    // A restore can only have gone back to a point that already existed, so
    // the source is always OLDER — further down a newest-first list. A
    // source at or above this row would be a corrupt record rather than a
    // shape to draw, and is dropped for the same reason a pruned one is.
    const sourceAt = v.restoredFrom === undefined ? undefined : indexById.get(v.restoredFrom)
    const arcTo = sourceAt !== undefined && sourceAt > i ? sourceAt : undefined
    const row: MiniGraphRow = {
      versionId: v.id,
      dotColor: branch?.color ?? FALLBACK_COLOR,
      active,
      connectorBefore: i > 0,
      isRestoreSource: false,
      isRestoreArcThrough: false,
      ...(labels && labels.length > 0 ? { branchOut: labels.join(', ') } : {}),
      ...(arcTo === undefined
        ? {}
        : { restoredFrom: v.restoredFrom as string, restoredFromDistance: arcTo - i }),
    }
    rows.push(row)
  }

  // The far end, marked in a second pass: a row can be an arc's source
  // before it has been built, and a drawing that labels only the top of an
  // arc reads as a line that goes nowhere.
  for (const [i, row] of rows.entries()) {
    if (row.restoredFrom === undefined) continue
    const at = indexById.get(row.restoredFrom)
    if (at === undefined) continue
    rows[at]!.isRestoreSource = true
    for (let mid = i + 1; mid < at; mid++) rows[mid]!.isRestoreArcThrough = true
  }
  return rows
}
