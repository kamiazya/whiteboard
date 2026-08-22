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
  /**
   * Present iff the user pinned this document; the value is its position
   * among the pinned. Pinned documents outrank the path sort everywhere the
   * panel orders a flat run of documents — the grid this panel replaced put
   * them first, and retiring it must not silently lose that.
   */
  readonly pinOrder?: number
}

/**
 * The one document ordering: pinned first (in pin order), then by path.
 * Folder pane and search results both use it, so the two can never rank the
 * same pair differently.
 */
export function compareDocumentEntries(
  left: { readonly path: string; readonly pinOrder?: number },
  right: { readonly path: string; readonly pinOrder?: number },
): number {
  if ((left.pinOrder === undefined) !== (right.pinOrder === undefined)) {
    return left.pinOrder === undefined ? 1 : -1
  }
  if (
    left.pinOrder !== undefined &&
    right.pinOrder !== undefined &&
    left.pinOrder !== right.pinOrder
  ) {
    return left.pinOrder - right.pinOrder
  }
  return left.path.localeCompare(right.path)
}
