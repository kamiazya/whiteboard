import type { SpatialCanvas, StoredCoreFacets } from '@kamiazya/whiteboard-model'

/**
 * What one reference resolves to. Every half is optional and independent:
 * a markdown document has a body and facets but no spatial content, and a
 * canvas written before facets existed has content and none.
 */
export interface LoadedFileDocument {
  readonly canvas?: SpatialCanvas
  readonly facets?: StoredCoreFacets
  /**
   * The referenced document's NAME, which the workspace owns rather than the
   * content (ADR-0009 decision 2) — so an adapter reads it from wherever its
   * backend keeps placement, not from the facets it loaded alongside.
   */
  readonly name?: string
  /**
   * A markdown document's raw body. Raw rather than parsed, because an
   * adapter's job is to reach the backend — parsing is this hook's, done
   * once per load rather than inside the resolver (canvas-render calls that
   * during layout, for every file node, on every re-layout).
   */
  readonly body?: string
}

/** What a backend must supply for the seams to work against it. */
export interface DocumentFileAdapter {
  /** Distinguishes a stored image asset from a reference to another canvas. */
  isImageRef(file: string): boolean
  /**
   * Resolves a reference to the document behind it. Facets ride along on the
   * load the embed seam already performs — a second fetch just to read four
   * frontmatter fields would double every referenced document's cost.
   */
  loadDocument(ref: string): Promise<LoadedFileDocument | undefined>
  /** Resolves an image reference to a displayable URL, or undefined. */
  loadImageUrl(ref: string): Promise<string | undefined>
  /** Stores a picked/dropped/pasted image, returning its new reference. */
  storeImage(file: File): Promise<string | undefined>
}
