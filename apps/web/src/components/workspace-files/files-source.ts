import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocumentEntry } from './document-entry.js'

/**
 * Everything `WorkspaceFilesPanel` asks of the world, as one seam.
 *
 * The panel used to call the daemon's client functions directly, which made
 * the three-pane browser daemon-only — the single obstacle the
 * one-browser-both-modes ticket names. These operations are the panel's
 * whole data surface, measured from its imports rather than assumed: list,
 * create, rename, pin, and the two content reads its thumbnails and preview
 * need.
 *
 * Duplicate and delete are deliberately NOT here. Both stay with the page
 * (`onDuplicateDocument` / `onRequestDelete`), which owns the confirmation
 * dialog and the copy semantics — a second home for either would be a second
 * set of rules for the same destructive act.
 */
export interface WorkspaceFilesSource {
  listDocuments(): Promise<readonly WorkspaceDocumentEntry[]>
  createDocument(path: string, kind: DocumentKind): Promise<void>
  /** Move a document — and everything under it — to a new path. */
  renameDocumentPath(path: string, newPath: string): Promise<void>
  /**
   * Set what the document is called, or clear it (undefined) so readers
   * fall back to the path's last segment. The name lives in the WORKSPACE
   * (vocabulary.md), which is why this sits on the source and not on the
   * document's content.
   */
  setDocumentName(
    entry: Pick<WorkspaceDocumentEntry, 'documentId' | 'path'>,
    name: string | undefined,
  ): Promise<void>
  /**
   * Pin or unpin a document, which is what decides `pinOrder` on the next
   * list read. OPTIONAL: pinning is workspace state the daemon keeps, and a
   * browser-local workspace has nowhere to keep it — the panel omits the
   * affordance rather than offering one that cannot persist.
   */
  setPinned?(entry: Pick<WorkspaceDocumentEntry, 'path'>, pinned: boolean): Promise<void>
  /**
   * The OKF markdown of a markdown document, for row thumbnails and the
   * preview pane. Empty string when the document has no body yet.
   */
  loadMarkdown(entry: WorkspaceDocumentEntry): Promise<string>
  /**
   * The CURRENT Loro bytes of a spatial document — snapshot plus any delta
   * log folded in, because a thumbnail of the last snapshot is a thumbnail
   * of a document the user is not looking at.
   */
  loadSpatialSnapshot(entry: WorkspaceDocumentEntry): Promise<Uint8Array>
}

/**
 * The workspace this source points at does not exist.
 *
 * Named here so the panel can show its not-found state without knowing which
 * implementation it is talking to: the daemon adapter maps its 404 onto this,
 * the local adapter maps the port's `WorkspaceNotFoundError`.
 */
export class WorkspaceMissingError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace not found: "${workspaceId}"`)
    this.name = 'WorkspaceMissingError'
  }
}
