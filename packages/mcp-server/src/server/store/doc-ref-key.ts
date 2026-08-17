import type { DocRef } from '@kamiazya/whiteboard-ports'

/**
 * Canonical `docKey` for a DocRef. Encodes `kind` into the key so a document
 * and a `workspace-tree` ref that happen to share the same id string (e.g.
 * during a migration) never collide.
 *
 * The `canvas:` prefix is a STORED value, not an in-memory label: it is the
 * `docKey` column of `documentSnapshots` / `documentSnapshotChunks` /
 * `documentFrontiers` / `documentDeltas`. It deliberately does NOT follow
 * `DocRef.kind`, which this codebase renamed to `document` — a kind is
 * in-memory and free to move, a stored key is not.
 *
 * Correcting the prefix needs more than a migration, which is why it is
 * still here: `0011-import-fs-blobs` writes `canvas:<documentId>` as a frozen
 * migration-time literal, and `prepareDataDir` calls its `importFsBlobs`
 * routine again on EVERY boot (closing the window where a pre-flip process
 * writes an FS blob the migration never saw). A one-shot rewrite of existing
 * rows would therefore be undone by the next boot. Moving this prefix means
 * moving that import routine's literal in the same increment, and deciding
 * what a recorded migration is allowed to re-read — its own increment.
 */
export function docRefKey(docRef: DocRef): string {
  switch (docRef.kind) {
    case 'document':
      return `canvas:${docRef.documentId}`
    case 'workspace-tree':
      return `workspace-tree:${docRef.workspaceId}`
  }
}
