import { workspaceIdSchema } from '@kamiazya/whiteboard-model'
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
 * takes its prefix from here rather than spelling it itself.
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

const WORKSPACE_TREE_DOC_KEY = /^workspace-tree:(.+)$/

/**
 * The exact inverse of `docRefKey` for a `workspace-tree` ref: the workspace id
 * whose record this key addresses, or `null` for any key `docRefKey` could not
 * have written for one (a `document:*` key, another shape, or an id the
 * workspace-id schema refuses).
 *
 * A reader that decides something from the key — which keeper owns the row,
 * whether to seal it — asks here rather than parsing the prefix itself, so the
 * spelling stays in this file and a change to it cannot leave the reader
 * quietly answering for a shape that no longer exists.
 */
export function workspaceIdOfStoredDocKey(key: string): string | null {
  const workspaceId = WORKSPACE_TREE_DOC_KEY.exec(key)?.[1]
  if (workspaceId === undefined) return null
  return workspaceIdSchema.safeParse(workspaceId).success ? workspaceId : null
}
