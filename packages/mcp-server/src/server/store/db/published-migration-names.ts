// Source of truth for migration names that have shipped in published releases.
//
// kysely keys its migration log by name, so a name that ever reached users is a
// compatibility contract: removing or renaming it breaks databases that recorded
// it. published-migration-names.test.ts asserts the runtime provider
// (migrations/index.ts) matches this list exactly, so any add/removal lands in
// the same diff a reviewer sees.
//
// Adding a migration: add its name here in the same commit.
// Removing a published migration (allowed under the pre-1.0 disposable-DB
// policy, but never silently): move it to RETIRED_MIGRATION_NAMES in the same
// commit and document the upgrade path (docs/contributing/mcp-debugging.md,
// Database Migration Errors).
export const PUBLISHED_MIGRATION_NAMES = ['0001-baseline'] as const satisfies readonly string[]

// The history the baseline replaced. Before 1.0 the forty-seven steps that had
// accumulated were folded into one `0001-baseline` equal to `schema.ts`, under
// the disposable-database policy: nothing upgrades a database from them. A log
// naming any of these is refused at boot with `IncompatibleDatabaseError`, whose
// message carries the way across — export each document from the earlier
// release and import it on a fresh data directory. The names are kept so that
// refusal can tell this case from a newer release's database, and so no new
// migration reuses one (it would read as already applied on exactly the
// databases this list exists to refuse).
export const RETIRED_MIGRATION_NAMES = [
  '0001-init',
  '0002-canvases-last-compacted-at',
  '0003-canvas-doc-store',
  '0004-workspace-index',
  '0005-canvases-kind',
  '0006-drop-workspace-index',
  '0007-adopt-workspace-tree',
  '0008-ulid-legacy-canvas-ids',
  '0009-document-vocabulary',
  '0010-document-path',
  '0011-import-fs-blobs',
  '0012-ulid-remaining-document-ids',
  '0013-document-dockey-prefix',
  '0014-versions-workspace-scoped',
  '0015-versions-branches-workspace-id',
  '0016-drop-documents-fk',
  '0017-drop-documents-table',
  '0018-workspace-segment',
  '0019-workspace-canonical-id',
  '0020-snapshot-generation',
  '0021-leases',
  '0022-version-restored-from',
  '0023-drop-branches',
  '0024-drop-version-thumbnails',
  '0025-version-operator-actor',
  '0026-version-content-digest',
  '0027-version-attestation',
  '0028-member-profiles',
  '0029-workspace-replica-keys',
  '0030-workspace-members-only',
  '0031-tenants',
  '0032-accounts',
  '0033-invitations',
  '0034-sign-in-sessions',
  '0035-sign-in-attempts',
  '0036-people-roles',
  '0037-user-deactivation',
  '0038-workspace-invitations',
  '0039-sign-in-authenticated-at',
  '0040-drop-invitation-email',
  '0041-drop-version-branch-name',
  '0042-sign-in-attempt-invitation-hash',
  '0043-drop-workspace-members-only',
  '0044-sign-in-attempt-source',
  '0045-sign-in-attempt-source-prefixes',
  '0046-workspace-namespace',
  '0047-sign-in-attempt-fresh',
] as const satisfies readonly string[]
