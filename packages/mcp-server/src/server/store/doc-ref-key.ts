import type { DocRef } from '@kamiazya/whiteboard-ports'

/**
 * Canonical `docKey` for a DocRef. Encodes `kind` into the key so a document
 * and a `workspace-tree` ref that happen to share the same id string (e.g.
 * during a migration) never collide.
 *
 * This is a STORED value, not an in-memory label: it is the `docKey` column
 * of `documentSnapshots` / `documentSnapshotChunks` / `documentFrontiers` /
 * `documentDeltas`. Changing it means migrating those rows — see
 * `0013-document-dockey-prefix` — and moving every frozen literal that a
 * boot-time routine still writes, which is why `importFsBlobs` and
 * `sweepImportedFsBlobs` take their prefix from here rather than spelling it
 * themselves.
 */
export function docRefKey(docRef: DocRef): string {
  switch (docRef.kind) {
    case 'document':
      return `document:${docRef.documentId}`
    case 'workspace-tree':
      return `workspace-tree:${docRef.workspaceId}`
  }
}

/**
 * The `docKey` prefix for a document, without needing a DocRef to hand.
 *
 * Exists for the two boot-time routines that walk the legacy FS blob tree
 * (`importFsBlobs`, `sweepImportedFsBlobs`) and know a documentId but not a
 * DocRef. They must agree with `docRefKey` exactly — a boot-time writer using
 * a stale prefix re-seeds rows the migration just corrected.
 */
export const DOCUMENT_DOC_KEY_PREFIX = 'document:'
