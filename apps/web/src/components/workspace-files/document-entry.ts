/**
 * One row of the workspace document list, as every pane of the browser
 * needs it. It lives here rather than with any one pane because three of
 * them read it and none of them owns it.
 */
export interface WorkspaceDocumentEntry {
  readonly documentId: string
  readonly path: string
  /**
   * What the document is called. Absent when nobody named it, which is when
   * the path's last segment is the honest label — never a fallback invented
   * from the name (a path derived from one collapses every non-Latin title
   * to `untitled-N`, which ADR-0008 measured and rejected).
   */
  readonly name?: string
  /** Which editor opens it, and which shape its icon takes. */
  readonly kind?: 'spatial' | 'markdown'
  /** Absent for a daemon that does not record it; the card then carries no age. */
  readonly updatedAt?: string
}
