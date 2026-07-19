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

  const rows: MiniGraphRow[] = []
  for (let i = 0; i < input.versions.length; i++) {
    const v = input.versions[i]!
    const branch = branchByName.get(v.branchName)
    const active = v.branchName === input.head
    const labels = branchOutByVersionId.get(v.id)
    const row: MiniGraphRow = {
      versionId: v.id,
      dotColor: branch?.color ?? FALLBACK_COLOR,
      active,
      connectorBefore: i > 0,
      ...(labels && labels.length > 0 ? { branchOut: labels.join(', ') } : {}),
    }
    rows.push(row)
  }
  return rows
}
