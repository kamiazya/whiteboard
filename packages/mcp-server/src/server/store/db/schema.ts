import type { DocumentKind } from '@kamiazya/whiteboard-model'
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

interface DocumentsTable {
  // Stable ULID that survives path renames. PK so child tables can FK on it.
  id: string
  workspaceId: string
  // Mutable display path; UNIQUE within (workspaceId, path).
  path: string
  displayName: string | null
  isPinned: Bool
  pinOrder: number | null
  currentBranch: string
  createdAt: Timestamp
  updatedAt: Timestamp
  // Last time the Loro op-log was successfully compacted via shallow-snapshot.
  // Null for documents that have never been compacted; consumed by the auto-
  // Optimize loop to skip documents that have not changed since last run.
  lastCompactedAt: Timestamp | null
  // Which editor opens this canvas. Null for rows created before this column
  // existed; the application layer maps null to 'spatial'.
  kind: DocumentKind | null
}

interface BranchesTable {
  documentId: string
  name: string
  tipFrontiers: string
  color: string | null
  sourceBranchName: string | null
  sourceVersionId: string | null
  createdAt: Timestamp
}

interface VersionsTable {
  id: string
  documentId: string
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

// Header row for a chunked DocumentStore snapshot. `docKey` is the
// DocRef-derived string from ../doc-ref-key.ts. Chunk bytes themselves live
// in DocumentSnapshotChunksTable; this row carries only the manifest
// scalars plus the frontier the snapshot was taken at.
interface DocumentSnapshotsTable {
  docKey: string
  chunkCount: number
  totalBytes: number
  maxChunkBytes: number
  frontier: Uint8Array
}

interface DocumentSnapshotChunksTable {
  docKey: string
  chunkIndex: number
  bytes: Uint8Array
}

// Append-only delta log. `frontier` is the batch's resulting frontier,
// duplicated onto every update row of that batch since ports'
// DeltaBatch carries one frontier per batch, not per update.
interface DocumentDeltasTable {
  docKey: string
  seq: number
  bytes: Uint8Array
  frontier: Uint8Array
}

// "Latest write wins" frontier per docKey, updated by both saveSnapshot and
// appendDeltas so readFrontier does not need to compare rows across the two
// differently-shaped logs above.
interface DocumentFrontiersTable {
  docKey: string
  frontier: Uint8Array
}

export interface DatabaseSchema {
  workspaces: WorkspacesTable
  documents: DocumentsTable
  branches: BranchesTable
  versions: VersionsTable
  runtime: RuntimeTable
  documentSnapshots: DocumentSnapshotsTable
  documentSnapshotChunks: DocumentSnapshotChunksTable
  documentDeltas: DocumentDeltasTable
  documentFrontiers: DocumentFrontiersTable
}
