import type { ColumnType, Generated } from 'kysely'

// Unix milliseconds.
type Timestamp = ColumnType<number, number, number>
// 0 / 1 stored as integer; expressed as boolean at the application layer.
type Bool = ColumnType<number, number, number>

export interface WorkspacesTable {
  id: string
  displayName: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface CanvasesTable {
  workspaceId: string
  slug: string
  displayName: string | null
  isPinned: Bool
  pinOrder: number | null
  currentBranch: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface BranchesTable {
  workspaceId: string
  slug: string
  name: string
  tipFrontiers: string
  color: string | null
  sourceBranchName: string | null
  sourceVersionId: string | null
  createdAt: Timestamp
}

export interface VersionsTable {
  id: string
  workspaceId: string
  slug: string
  branchName: string
  auto: Bool
  label: string | null
  operatorKind: 'ai' | 'human' | 'system'
  operatorPeerId: string
  operatorDisplayName: string | null
  operatorAgentId: string | null
  operatorWorkspaceId: string | null
  sizeBytes: number
  elementCount: number
  frontiers: string
  hasThumbnail: Bool
  createdAt: Timestamp
}

export interface PaletteTable {
  workspaceId: string
  key: string
  value: string
}

export interface InstalledLibrariesTable {
  workspaceId: string
  url: string
  installedAt: Timestamp
}

export interface UserLibrariesTable {
  name: string
  itemCount: number | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

// User-library metadata is keyed by library name and item key. Aliases / notes / scales
// are stored as JSON-encoded strings to keep the schema simple while preserving the
// nested manifest shape callers expect (UserLibraryMetadataManifest).
export interface UserLibraryMetadataTable {
  name: string
  manifestJson: string
  updatedAt: Timestamp
}

// Single-row key/value store for daemon-runtime markers (currentWorkspaceId,
// daemonPid, daemonStartedAt, etc.). Keeps the FS clean of tiny dot-files.
export interface RuntimeTable {
  key: string
  value: string | null
  updatedAt: Timestamp
}

// Tracks whether a generic quarantine bucket has been written for a (kind, scope, key)
// triple. Reused across schema migrations to avoid quarantining the same legacy data
// twice on repeated startups.
export interface QuarantineLogTable {
  id: Generated<number>
  kind: string
  scope: string
  key: string
  bucketPath: string
  createdAt: Timestamp
}

export interface DatabaseSchema {
  workspaces: WorkspacesTable
  canvases: CanvasesTable
  branches: BranchesTable
  versions: VersionsTable
  palette: PaletteTable
  installed_libraries: InstalledLibrariesTable
  user_libraries: UserLibrariesTable
  user_library_metadata: UserLibraryMetadataTable
  runtime: RuntimeTable
  quarantine_log: QuarantineLogTable
}
