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
  // Which editor opens this canvas. Null for rows created before this column
  // existed; the application layer maps null to 'spatial'.
  kind: 'spatial' | 'markdown' | null
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

// Header row for a chunked CanvasDocStore snapshot. `docKey` is the
// DocRef-derived string from ../doc-ref-key.ts. Chunk bytes themselves live
// in CanvasDocSnapshotChunksTable; this row carries only the manifest
// scalars plus the frontier the snapshot was taken at.
interface CanvasDocSnapshotsTable {
  docKey: string
  chunkCount: number
  totalBytes: number
  maxChunkBytes: number
  frontier: Uint8Array
}

interface CanvasDocSnapshotChunksTable {
  docKey: string
  chunkIndex: number
  bytes: Uint8Array
}

// Append-only delta log. `frontier` is the batch's resulting frontier,
// duplicated onto every update row of that batch since canvas-ports'
// DeltaBatch carries one frontier per batch, not per update.
interface CanvasDocDeltasTable {
  docKey: string
  seq: number
  bytes: Uint8Array
  frontier: Uint8Array
}

// "Latest write wins" frontier per docKey, updated by both saveSnapshot and
// appendDeltas so readFrontier does not need to compare rows across the two
// differently-shaped logs above.
interface CanvasDocFrontiersTable {
  docKey: string
  frontier: Uint8Array
}

// Five WorkspaceIndex-backing tables (canvas-ports' WorkspaceIndex port).
// `seq` is each row's position within the array its owning `applyRows` call
// received for that table — every query orders by it so results stay
// observationally identical to InMemoryWorkspaceIndex's array-order
// `.find()`/`.filter()` semantics (see 0004-workspace-index.ts).

interface WorkspaceIndexCanvasListTable {
  workspaceId: string
  seq: number
  canvasId: string
  title: string
  updatedAtMs: number
}

interface WorkspaceIndexFacetsTable {
  workspaceId: string
  seq: number
  facet: string
  value: string
  canvasId: string
}

interface WorkspaceIndexAliasesTable {
  workspaceId: string
  seq: number
  alias: string
  canvasId: string
}

interface WorkspaceIndexBacklinksTable {
  workspaceId: string
  seq: number
  fromCanvasId: string
  toCanvasId: string
}

interface WorkspaceIndexAliasHistoryTable {
  workspaceId: string
  seq: number
  alias: string
  canvasId: string
  retiredAtMs: number
}

export interface DatabaseSchema {
  workspaces: WorkspacesTable
  canvases: CanvasesTable
  branches: BranchesTable
  versions: VersionsTable
  runtime: RuntimeTable
  canvasDocSnapshots: CanvasDocSnapshotsTable
  canvasDocSnapshotChunks: CanvasDocSnapshotChunksTable
  canvasDocDeltas: CanvasDocDeltasTable
  canvasDocFrontiers: CanvasDocFrontiersTable
  workspaceIndexCanvasList: WorkspaceIndexCanvasListTable
  workspaceIndexFacets: WorkspaceIndexFacetsTable
  workspaceIndexAliases: WorkspaceIndexAliasesTable
  workspaceIndexBacklinks: WorkspaceIndexBacklinksTable
  workspaceIndexAliasHistory: WorkspaceIndexAliasHistoryTable
}
