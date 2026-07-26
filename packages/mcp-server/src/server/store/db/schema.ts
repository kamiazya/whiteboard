import type { ColumnType } from 'kysely'

// Unix milliseconds.
type Timestamp = ColumnType<number, number, number>
// 0 / 1 stored as integer; expressed as boolean at the application layer.
type Bool = ColumnType<number, number, number>

interface WorkspacesTable {
  id: string
  displayName: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

interface CanvasesTable {
  // Stable nanoid that survives slug renames. PK so child tables can FK on it.
  id: string
  workspaceId: string
  // Mutable display path; UNIQUE within (workspaceId, slug).
  slug: string
  displayName: string | null
  isPinned: Bool
  pinOrder: number | null
  currentBranch: string
  createdAt: Timestamp
  updatedAt: Timestamp
  // Last time the Loro op-log was successfully compacted via shallow-snapshot.
  // Null for canvases that have never been compacted; consumed by the auto-
  // Optimize loop to skip canvases that have not changed since last run.
  lastCompactedAt: Timestamp | null
}

interface BranchesTable {
  canvasId: string
  name: string
  tipFrontiers: string
  color: string | null
  sourceBranchName: string | null
  sourceVersionId: string | null
  createdAt: Timestamp
}

interface VersionsTable {
  id: string
  canvasId: string
  branchName: string
  auto: Bool
  label: string | null
  operatorKind: 'ai' | 'human' | 'system'
  operatorPeerId: string
  operatorDisplayName: string | null
  operatorAgentId: string | null
  operatorWorkspaceId: string | null
  elementCount: number
  frontiers: string
  hasThumbnail: Bool
  createdAt: Timestamp
}

// Single-row key/value store for daemon-runtime markers (currentWorkspaceId,
// daemonPid, daemonStartedAt, etc.). Keeps the FS clean of tiny dot-files.
interface RuntimeTable {
  key: string
  value: string | null
  updatedAt: Timestamp
}

export interface DatabaseSchema {
  workspaces: WorkspacesTable
  canvases: CanvasesTable
  branches: BranchesTable
  versions: VersionsTable
  runtime: RuntimeTable
}
