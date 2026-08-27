import type { DocRef } from './doc-ref.js'

/**
 * Canonical `docKey` for a DocRef. Encodes `kind` into the key so a document
 * and a `workspace-tree` ref that happen to share the same id string (e.g.
 * during a migration) never collide.
 *
 * This is a STORED value, not an in-memory label: it is the daemon's `docKey`
 * column on `documentSnapshots` / `documentSnapshotChunks` /
 * `documentFrontiers` / `documentDeltas`, and the browser's key into the
 * matching IndexedDB stores. Changing it means migrating those rows — see
 * mcp-server's `0013-document-dockey-prefix` — and moving every frozen
 * literal that a boot-time routine still writes, which is why `importFsBlobs`
 * and `sweepImportedFsBlobs` take their prefix from here rather than spelling
 * it themselves.
 *
 * It lives in `ports` rather than beside one implementation for the reason
 * above: two stores that disagree about this string are two stores that
 * cannot read each other's documents, and nothing would say so at compile
 * time.
 */
export function docRefKey(docRef: DocRef): string {
  switch (docRef.kind) {
    case 'document':
      // Deliberately NOT `document:<workspaceId>:<documentId>` even though
      // the ref now carries the workspace: a documentId is a ULID and
      // already globally unique, and the boot fold must keep reading and
      // sweeping legacy per-document rows written under exactly this key on
      // any not-yet-folded database.
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
