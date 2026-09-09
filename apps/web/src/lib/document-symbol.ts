/**
 * The mark a document wears, whichever kind it is.
 *
 * Both document pages need this and they used to answer it inline, which is
 * how one of them came to answer it for spatial documents only: the two
 * kinds keep the mark in different places, so the branch has to be written
 * down somewhere, and written twice it drifts. A SPATIAL document keeps its
 * symbol on the canvas envelope — the same bucket the edge-style facet uses
 * — while a MARKDOWN one keeps its in the frontmatter facets, which are no
 * canvas value at all and reach a page on the sync session's own reading.
 *
 * Total: an unresolvable payload, an absent bucket and a canvas that has not
 * arrived yet all answer `undefined`, which every surface treats as "draw
 * what you would have drawn anyway".
 */

import type { DocumentKind, ExtensionFacets, SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  resolveCanvasSymbol,
  resolveDocumentSymbol,
  type VisualSymbolFacet,
} from '@kamiazya/whiteboard-plugin-visual'

export interface DocumentSymbolInput {
  readonly kind: DocumentKind
  /** The live canvas, for a spatial document. Null or undefined before it arrives. */
  readonly canvas?: SpatialCanvas | null
  /** The document's extension facets, for a markdown one. */
  readonly facets?: ExtensionFacets
}

export function resolveOpenDocumentSymbol({
  kind,
  canvas,
  facets,
}: DocumentSymbolInput): VisualSymbolFacet | undefined {
  if (kind === 'spatial') {
    return canvas === null || canvas === undefined ? undefined : resolveCanvasSymbol(canvas)
  }
  return resolveDocumentSymbol(facets)
}
