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
  // The read plane's per-workspace tier override (ADR-0042 decisions 1/3/5).
  // null means "use the process's WHITEBOARD_REPLICA_TIER default" — see
  // migration 0029.
  replicaTier: string | null
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
  // '' is a real value here: no operator at all. See version-store's
  // `VersionRow`, which carries the same pair and says why.
  operatorKind: '' | 'ai' | 'human' | 'system'
  operatorActor: string
  operatorDisplayName: string | null
  operatorAgentId: string | null
  operatorWorkspaceId: string | null
  elementCount: number
  frontiers: string
  // The identity of the content this point was taken of, and what
  // `isUnchangedSinceLastVersion` compares. The workspace-scoped `frontiers`
  // above answer a different question: they move when ANY document in the
  // workspace is edited.
  //
  // Never empty on a row this store wrote — `contentDigestOf` always answers.
  // The column's `''` default exists only because sqlite requires one to add
  // a NOT NULL column, and 0026 deleted every row that would have taken it.
  contentDigest: string
  createdAt: Timestamp
  // Set only on the point a restore produced; see `versionEntrySchema`.
  restoredFrom: string | null
  // The raw WebAuthn assertion as JSON (`attestationSchema`), when the
  // operation that wrote this row asked a person for one (ADR-0039). Null
  // means not asked, which is most rows by design.
  attestation: string | null
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

// ADR-0041's L1 subject: a person, identified by the passkey credentials the
// daemon has already pinned. No key material — a credential id is only a
// public handle (decision 1).
interface MemberProfilesTable {
  id: string
  displayName: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

// A pinned passkey belongs to at most one profile; (credentialId, origin)
// mirrors the pin's own identity in webauthn-credential-store.ts. No FK to
// memberProfiles — house style since 0016/0017.
interface ProfileCredentialsTable {
  credentialId: string
  origin: string
  profileId: string
}

// L1 membership as a ROW, deliberately outside the CRDT-synced workspace
// record (ADR-0019) so a sync merge cannot resurrect a revoked row. No
// tombstone: revocation is a plain delete (ADR-0042 decision 3).
interface WorkspaceMembershipsTable {
  workspaceId: string
  profileId: string
  createdAt: Timestamp
}

// The read plane's per-workspace content key (ADR-0042 decisions 1/3/5,
// ADR-0043 decision 3). One row per workspace, minted lazily; no epoch here
// (a document's own epoch lives beside its ciphertext, not on this key).
interface WorkspaceReplicaKeysTable {
  workspaceId: string
  key: Uint8Array
  salt: Uint8Array
  createdAt: Timestamp
}

// Whether a workspace has ever had a member — set once by `addMember`'s
// first insert, never cleared by `revokeL1Membership` (user decision
// 2026-09-21: removing the sole member does not revert a workspace to
// origin trust). Outside `workspaces` on purpose; see the 0030 migration.
interface WorkspaceMembersOnlyTable {
  workspaceId: string
  since: Timestamp
}

// Every tenant-scoped table (`tenant-scope.ts`) also has a `tenantId` column,
// deliberately NOT declared here: the tenant-bound handle stamps it on insert,
// filters on it and strips it from results, so a store cannot name it at all.
// `tenant-database.test.ts` checks the physical columns against the ledger.
interface TenantsTable {
  id: string
  createdAt: Timestamp
}

export interface DatabaseSchema {
  workspaces: WorkspacesTable
  versions: VersionsTable
  runtime: RuntimeTable
  documentSnapshots: DocumentSnapshotsTable
  documentSnapshotChunks: DocumentSnapshotChunksTable
  documentDeltas: DocumentDeltasTable
  documentFrontiers: DocumentFrontiersTable
  leases: LeasesTable
  memberProfiles: MemberProfilesTable
  profileCredentials: ProfileCredentialsTable
  workspaceMemberships: WorkspaceMembershipsTable
  workspaceReplicaKeys: WorkspaceReplicaKeysTable
  workspaceMembersOnly: WorkspaceMembersOnlyTable
  tenants: TenantsTable
}
