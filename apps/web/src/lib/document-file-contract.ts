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

/**
 * What storing an image came to. A refusal carries the sentence a person
 * reads: `undefined` for a failed upload was indistinguishable from "nothing
 * happened", so the click that triggered it did nothing visible.
 */
export type ImageStoreResult =
  | { readonly ok: true; readonly ref: string }
  | { readonly ok: false; readonly reason: string }

/** What a backend must supply for the seams to work against it. */
export interface DocumentFileAdapter {
  /**
   * Where this keeper's stored pictures live: two adapters answering the same
   * scope hold the same bytes. The browser keeps one store per origin, the
   * daemon one per workspace, so a copied picture pasted into another scope
   * has to be stored again there.
   */
  readonly fileScope: string
  /** Distinguishes a stored image asset from a reference to another canvas. */
  isImageRef(file: string): boolean
  /**
   * Resolves a reference to the document behind it. Facets ride along on the
   * load the embed seam already performs — a second fetch just to read four
   * frontmatter fields would double every referenced document's cost.
   *
   * The two non-answers are opposite instructions to the seam that caches
   * this. `undefined` asserts the document is ABSENT and is terminal: cached
   * until the target's stamp moves. A REJECTION means the read failed — a
   * busy store, a dropped request — and is asked again. Folding a failure
   * into `undefined` leaves the embed blank for the life of the page.
   */
  loadDocument(ref: string): Promise<LoadedFileDocument | undefined>
  /**
   * Resolves an image reference to a displayable URL. The two non-answers
   * mean what they do for `loadDocument`: `undefined` asserts the picture is
   * ABSENT and is terminal, while a REJECTION is a failed read and is asked
   * again. Folding a failure into `undefined` leaves the picture on its card
   * for the life of the page.
   */
  loadImageUrl(ref: string): Promise<string | undefined>
  /**
   * A stored image's bytes, on `loadImageUrl`'s terms for its non-answers. A
   * copy reads these rather than fetching the URL above: the app's policy
   * refuses `connect-src blob:`.
   */
  loadImageBlob(ref: string): Promise<Blob | undefined>
  /** Stores a picked/dropped/pasted image, answering its new reference or why not. */
  storeImage(file: File): Promise<ImageStoreResult>
}
