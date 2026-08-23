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
  /**
   * `name` is what a human reads, applied by the SAME call that creates the
   * document. Split into a create then a set-name, the second half can fail
   * alone and leave a document the user named sitting in the list as
   * untitled-N, with nothing on screen saying which half went wrong.
   */
  createDocument(path: string, kind: DocumentKind, name?: string): Promise<void>
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
   * Documents whose CONTENT answers the query, best first — the search a
   * name-and-path filter cannot do.
   *
   * Both modes answer through the same stage-0 core (`@kamiazya/whiteboard-search`),
   * so a query finds the same documents whether a daemon or the browser
   * ranked them. An empty query answers nothing: the caller shows the
   * folder's own contents, and deciding that here would put it in two
   * places (`search-documents.ts` says the same for the name filter).
   */
  searchDocuments(query: string, limit?: number): Promise<readonly DocumentSearchHit[]>
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
/**
 * One search result: the document, plus why it is here.
 *
 * `contexts` are excerpts around the match, one per text source that
 * matched. When the daemon's semantic search put a document here that no
 * keyword matched, there IS no match window — the excerpt is then the
 * document's opening, and nothing in it should be highlighted.
 */
export interface DocumentSearchHit {
  readonly document: WorkspaceDocumentEntry
  readonly contexts: readonly string[]
  /**
   * Where this document sat in the KEYWORD ranking, 1-based, or absent when
   * keywords never matched it.
   *
   * Absent is the case worth having: it says there is nothing in `contexts`
   * to highlight, which no reader can infer from the excerpt's shape. Local
   * mode has no embedder, so every hit it produces carries one.
   *
   * 1-based deliberately — a rank of 0 is falsy, and `if (hit.lexicalRank)`
   * would read the top hit as no hit.
   */
  readonly lexicalRank?: number
  /**
   * Where this document sat in the semantic ranking, 1-based, or absent when
   * no embedder was configured. Reported rather than folded into a "matched
   * by meaning" label: every embedded document appears in that ranking, so
   * presence alone says nothing, and the threshold that would make it mean
   * something belongs to whoever displays the results.
   */
  readonly semanticRank?: number
}

export class WorkspaceMissingError extends Error {
  constructor(workspaceId: string) {
    super(`Workspace not found: "${workspaceId}"`)
    this.name = 'WorkspaceMissingError'
  }
}
