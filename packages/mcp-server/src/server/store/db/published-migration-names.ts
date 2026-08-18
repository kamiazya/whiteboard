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
// policy, but never silently): remove it here in the same commit and add an
// upgrade/announcement note (see docs/contributing/mcp-debugging.md).
export const PUBLISHED_MIGRATION_NAMES = [
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
] as const satisfies readonly string[]
