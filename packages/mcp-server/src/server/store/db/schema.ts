import type { ColumnType } from 'kysely'

// Unix milliseconds.
type Timestamp = ColumnType<number, number, number>
// 0 / 1 stored as integer; expressed as boolean at the application layer.
type Bool = ColumnType<number, number, number>

interface WorkspacesTable {
  id: string
  displayName: string | null
  // ADR-0019's user-facing handle: unique per keeper (enforced by the
  // `workspaces_segment_unique` index added in migration 0018), nullable
  // because a workspace minted before that migration has none until Wave-2
  // backfill/minting.
  segment: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

interface BranchesTable {
  documentId: string
  workspaceId: string
  name: string
  tipFrontiers: string
  color: string | null
  sourceBranchName: string | null
  sourceVersionId: string | null
  createdAt: Timestamp
}

interface VersionsTable {
  id: string
  // No FK since migration 0016 — delete paths sweep these rows explicitly
  // (documentTeardown's bracket). Reads key on workspaceId, whose oplog the
  // frontiers point into.
  documentId: string
  workspaceId: string
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
  // Set only on the point a restore produced; see `versionEntrySchema`.
  restoredFrom: string | null
}

// Single-row key/value store for daemon-runtime markers (currentWorkspaceId,
// daemonPid, daemonStartedAt, etc.). Keeps the FS clean of tiny dot-files.
interface RuntimeTable {
  key: string
  value: string | null
  updatedAt: Timestamp
}

// Header row for a chunked DocumentStore snapshot. `docKey` is the
// DocRef-derived string from ports' doc-ref-key.ts. Chunk bytes themselves live
// in DocumentSnapshotChunksTable; this row carries only the manifest
// scalars plus the frontier the snapshot was taken at.
interface DocumentSnapshotsTable {
  docKey: string
  chunkCount: number
  totalBytes: number
  maxChunkBytes: number
  frontier: Uint8Array
  // ADR-0020's fencing token: advanced by every write that replaces this row,
  // read with the manifest, and presented back on a fold to make the replace
  // conditional.
  generation: number
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

interface LeasesTable {
  // The lease's subject, e.g. `backup`. One row per name.
  name: string
  // Whichever instance currently holds it — the daemon's own `instanceId`,
  // which is minted per process, so it survives nothing and identifies
  // exactly one live process.
  holder: string
  // Unix milliseconds. A holder that stops renewing lapses here; nothing
  // else frees it, because nothing else can tell a dead instance from a slow
  // one across a container boundary.
  expiresAt: Timestamp
}

export interface DatabaseSchema {
  workspaces: WorkspacesTable
  branches: BranchesTable
  versions: VersionsTable
  runtime: RuntimeTable
  documentSnapshots: DocumentSnapshotsTable
  documentSnapshotChunks: DocumentSnapshotChunksTable
  documentDeltas: DocumentDeltasTable
  documentFrontiers: DocumentFrontiersTable
  leases: LeasesTable
}
