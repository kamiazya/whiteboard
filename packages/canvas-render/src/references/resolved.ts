// What a reference RESOLVES to, as plain data: the contents a file node
// draws, the card a facet maps to, and the body an embed lays out inline.
// They live under `references/` because decision 14 gives that directory the
// seams, and a seam's answer type is part of the seam — leaving them in the
// layout modules made the producer of the seams import the layout back, a
// loop that only `import type` kept from failing at load.
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'

/**
 * Presentation-shaped card content for a file node, mapped by the caller
 * from its own facet data (model's `coreFacetsSchema` and friends).
 * Deliberately NOT domain-shaped: this package renders "one bare heading
 * line, then labelled rows" and learns nothing about what a facet MEANS —
 * the semantic mapping (`title = facets.title ?? facets.type`, one row per
 * core facet) is the caller's job. Plain TS, not Zod, per
 * zod-schema-discipline: it is constructed and consumed entirely
 * in-process and never crosses a process boundary.
 */
export interface FacetCardData {
  readonly title?: string
  readonly rows: readonly { readonly label: string; readonly value: string }[]
}

/**
 * What a caller knows about one reference. Every field is optional and
 * independent — a caller supplies what it has, and the ranking below
 * decides what gets painted.
 *
 * The content fields are ranked, highest first: `image` (a scaled-down
 * picture is still a meaningful thumbnail, so it is not LOD-gated),
 * `canvas` (inline-embedded, depth-capped at 3 with path-local cycle
 * detection, and gated by `expandFileNode`), `markdown` (the document's own
 * prose, which says more about it than the facets describing it), then
 * `facets`. Anything that produces no usable content — an empty body, a
 * card with no title or rows, a box too small for one block — falls through
 * to the next rank and finally to the plain chrome+label rendering.
 */
export interface ResolvedReference {
  /**
   * Human-readable name, for a caller whose references are opaque ids (the
   * browser-local store). Absent falls back to the raw reference string,
   * which is why an export that resolves nothing keeps labels a pure
   * function of the canvas.
   *
   * A document's name lives in the workspace, not in its content
   * (vocabulary.md) — which is why the markdown body below carries no title
   * of its own, unlike `MdastLayoutOptions.resolveEmbed`, whose embed mixed
   * into prose has no other name source.
   */
  readonly label?: string
  /**
   * The reference points at a target that no longer exists (deleted
   * document, an imported ref into a store that never had it). Renders a
   * quiet "Missing reference" label instead of the raw reference, which for
   * an opaque id tells a reader nothing. This package only paints the
   * state; deciding it is a lookup against the live document list, and so
   * the caller's.
   */
  readonly missing?: boolean
  /** A renderable image: `href` is emitted verbatim into the SVG — a data: URI in exports, a blob:/app URL in the editor. */
  readonly image?: { readonly href: string; readonly alt?: string }
  /** The referenced spatial canvas, for inline embedding. */
  readonly canvas?: SpatialCanvas
  /** A referenced markdown document's already-parsed body. */
  readonly markdown?: MdastRoot
  /** Card content built from the referenced document's facet data. */
  readonly facets?: FacetCardData
}

/**
 * What an embed target resolves to: a markdown document's parsed body, or a
 * spatial document's canvas. Discriminated by which field is present, the
 * way `ResolvedReference` is on the spatial side.
 */
export type EmbeddedDocument =
  | { readonly title?: string; readonly root: MdastRoot }
  | { readonly title?: string; readonly canvas: SpatialCanvas }
