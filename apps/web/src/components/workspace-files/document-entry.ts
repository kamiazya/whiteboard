/**
 * One row of the workspace document list, as every pane of the browser
 * needs it. It lives here rather than with any one pane because three of
 * them read it and none of them owns it.
 */

import type { DocumentKind } from '@kamiazya/whiteboard-model'

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
  /**
   * Which editor opens it, and which shape its icon takes.
   *
   * `DocumentKind` rather than a copy of its members. Written out by hand it
   * is a parallel union that quietly EXCLUDES a newly added kind, so the
   * places that route a row by kind never see one — and the compile error
   * lands in whichever files-source builds the entry instead of at the
   * decision that has to be made. Measured by adding a third kind: the row
   * renderer and the row outliner both stayed silent, and `local-files-source`
   * and `daemon-files-source` failed in their place.
   */
  readonly kind?: DocumentKind
  /** Absent for a daemon that does not record it; the card then carries no age. */
  readonly updatedAt?: string
  /**
   * OKF core-facet tags, for search and filter chips. Absent when the
   * document carries none (spatial documents always: core facets are a
   * markdown concern) — absence and emptiness render identically, so only
   * one of them travels.
   */
  readonly tags?: readonly string[]
  /**
   * Present iff the user pinned this document; the value is its position
   * among the pinned. Pinned documents outrank the path sort everywhere the
   * panel orders a flat run of documents — the grid this panel replaced put
   * them first, and retiring it must not silently lose that.
   */
  readonly pinOrder?: number
  /**
   * True when an earlier sibling owns this path — reachable only through
   * concurrent creation on two replicas. Shown as a conflict badge; the
   * user resolves it explicitly by renaming (never a silent auto-suffix).
   */
  readonly shadowed?: true
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
