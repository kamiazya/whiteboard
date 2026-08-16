import type { DocRef } from '@kamiazya/whiteboard-ports'

/**
 * Canonical map key for a DocRef. Encodes `kind` into the key so a
 * `canvas` and a `workspace-tree` ref that happen to share the same id
 * string (e.g. during a migration) never collide.
 */
export function docRefKey(docRef: DocRef): string {
  switch (docRef.kind) {
    case 'canvas':
      return `canvas:${docRef.documentId}`
    case 'workspace-tree':
      return `workspace-tree:${docRef.workspaceId}`
  }
}
