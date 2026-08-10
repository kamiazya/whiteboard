/**
 * Scene graph type definitions. Plain TypeScript types, NOT Zod schemas.
 *
 * This is a deliberate boundary decision, not an oversight: the scene graph
 * never crosses a process boundary (only the SVG string produced by the
 * backend and the `sceneDigest` JSON are exported from this package), so
 * per YAGNI + this repo's zod-schema-discipline it needs no runtime schema.
 * The SVG-fragment scene node (the math/diagram seam) is likewise a plain
 * TS variant of this union for the same reason. `sceneDigest`'s output is
 * the only Zod-schematized surface in this package — see `scene-digest.ts`.
 *
 * Scene nodes retain semantic provenance (heading level, list structure,
 * link targets, wikiLink/embed canvas ids) as first-class fields rather
 * than flattening to visual-only attributes, because the planned a11y
 * parallel-DOM projection recovers document semantics FROM the scene graph,
 * not from the original mdast (see the ticket's resolved a11y note).
 */

export interface BoundingBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface Dimensions {
  readonly w: number
  readonly h: number
}

/**
 * Resolved paint attributes for a shape, text run, or edge. Optional and
 * assigned, never invented: layout produces geometry and semantics only,
 * and this package's own layout functions must not choose a fill, stroke,
 * or font — that is a composition-root concern today and the exact seam
 * the planned theme layer fills in later (a pure scene-graph ->
 * scene-graph transform). One named type is reused across every paintable
 * variant rather than ad-hoc per-kind fields, and every field is optional
 * so an appearance-free scene renders exactly as it always has.
 */
export interface Appearance {
  readonly fill?: string
  readonly stroke?: string
  readonly strokeWidth?: number
  readonly fontFamily?: string
  readonly fontSize?: number
}

/** A single styled run of inline text, positioned within its parent block. */
export interface TextRunNode {
  readonly kind: 'textRun'
  readonly bbox: BoundingBox
  readonly text: string
  readonly emphasis?: boolean
  readonly strong?: boolean
  readonly code?: boolean
  readonly deleted?: boolean
  /** Present when this run is (or is inside) a link/wikiLink/reference. */
  readonly link?: LinkProvenance
  readonly appearance?: Appearance
  /**
   * Distance (px) from `bbox.y` (the line TOP) down to the text baseline,
   * i.e. the measured font ascent. `bbox` stays a true top-left box either
   * way — sceneBounds/sceneDigest read `bbox`, never this field — so an
   * absent `baseline` renders exactly as it always has (SVG `y = bbox.y`),
   * and a present one only shifts where the glyphs paint within that box.
   */
  readonly baseline?: number
}

/**
 * The box chrome of a spatial canvas node: a rectangle with an optional
 * uniform corner radius. Deliberately minimal — a rect covers every
 * spatial node kind today, so ellipse/polygon/path are not added
 * speculatively (see package-canvas-render.md).
 */
export interface ShapeSceneNode {
  readonly kind: 'shape'
  readonly bbox: BoundingBox
  /** Uniform corner radius. Non-finite or <= 0 omits `rx` entirely. */
  readonly radius?: number
  readonly appearance?: Appearance
}

/** Semantic provenance for an inline link-like run. Never flattened away. */
export type LinkProvenance =
  | { readonly kind: 'link'; readonly href: string; readonly title?: string }
  | { readonly kind: 'wikiLink'; readonly canvasId: string; readonly alias?: string }
  | { readonly kind: 'embed'; readonly canvasId: string }

/** A block-level heading. `level` is the semantic heading depth (1-6). */
export interface HeadingBlockNode {
  readonly kind: 'heading'
  readonly bbox: BoundingBox
  readonly level: 1 | 2 | 3 | 4 | 5 | 6
  readonly runs: readonly TextRunNode[]
}

export interface ParagraphBlockNode {
  readonly kind: 'paragraph'
  readonly bbox: BoundingBox
  readonly runs: readonly TextRunNode[]
}

/** One item within a ListBlockNode. Retains ordinal + nesting depth. */
export interface ListItemNode {
  readonly kind: 'listItem'
  readonly bbox: BoundingBox
  /** 1-based ordinal when the parent list is ordered; undefined otherwise. */
  readonly ordinal?: number
  readonly checked?: boolean
  readonly children: readonly SceneNode[]
}

export interface ListBlockNode {
  readonly kind: 'list'
  readonly bbox: BoundingBox
  readonly ordered: boolean
  /** Nesting depth from the document root; top-level lists are depth 0. */
  readonly depth: number
  readonly items: readonly ListItemNode[]
}

export interface CodeBlockNode {
  readonly kind: 'codeBlock'
  readonly bbox: BoundingBox
  readonly value: string
  readonly lang?: string
}

export interface BlockquoteNode {
  readonly kind: 'blockquote'
  readonly bbox: BoundingBox
  readonly children: readonly SceneNode[]
}

export interface ThematicBreakNode {
  readonly kind: 'thematicBreak'
  readonly bbox: BoundingBox
}

export interface TableCellSceneNode {
  readonly kind: 'tableCell'
  readonly bbox: BoundingBox
  readonly runs: readonly TextRunNode[]
}

export interface TableRowSceneNode {
  readonly kind: 'tableRow'
  readonly bbox: BoundingBox
  readonly cells: readonly TableCellSceneNode[]
}

export interface TableBlockNode {
  readonly kind: 'table'
  readonly bbox: BoundingBox
  readonly rows: readonly TableRowSceneNode[]
}

/** Raw HTML passed through verbatim per package-canvas-render.md's fallback rule. */
export interface RawHtmlNode {
  readonly kind: 'rawHtml'
  readonly bbox: BoundingBox
  readonly value: string
}

/** An unresolved link/image reference, rendered per the documented fallback. */
export interface UnresolvedReferenceNode {
  readonly kind: 'unresolvedReference'
  readonly bbox: BoundingBox
  readonly identifier: string
}

/**
 * The math/diagram seam. The composition root supplies an already
 * well-formed SVG fragment string (its precondition, not this package's
 * responsibility to validate); the backend wraps it in a `<g>` and emits
 * it verbatim. MathJax itself is never imported here.
 */
export interface SvgFragmentNode {
  readonly kind: 'svgFragment'
  readonly bbox: BoundingBox
  readonly svg: string
  readonly role?: 'presentation'
}

/** A recursively-resolved embed. Placeholder shape carries title+link only. */
export interface EmbedPlaceholderNode {
  readonly kind: 'embedPlaceholder'
  readonly bbox: BoundingBox
  readonly canvasId: string
  readonly title: string
  readonly reason: 'cycle' | 'depthCap' | 'unresolvable'
}

export interface EmbedResolvedNode {
  readonly kind: 'embedResolved'
  readonly bbox: BoundingBox
  readonly canvasId: string
  readonly children: readonly SceneNode[]
}

/**
 * A rendered raster/vector image. `href` is emitted verbatim as the SVG
 * image reference — a data: URI in exports (deterministic given the same
 * bytes), a blob:/app URL in the live editor. Aspect is always preserved
 * (xMidYMid meet), so the bbox is the FRAME, not necessarily the painted
 * extent.
 */
export interface ImageSceneNode {
  readonly kind: 'image'
  readonly bbox: BoundingBox
  readonly href: string
  /** Accessible name for the image; absent renders as presentation. */
  readonly alt?: string
}

export interface GroupSceneNode {
  readonly kind: 'group'
  readonly bbox: BoundingBox
  readonly label?: string
  readonly children: readonly SceneNode[]
}

export interface ResolvedEdgeNode {
  readonly kind: 'edge'
  readonly id: string
  readonly path: readonly { readonly x: number; readonly y: number }[]
  readonly fromSide: 'top' | 'right' | 'bottom' | 'left'
  readonly toSide: 'top' | 'right' | 'bottom' | 'left'
  // Always resolved by the producer (routeEdge applies the JSON Canvas
  // defaults: fromEnd 'none', toEnd 'arrow') — required here so no scene
  // constructor can forget which ends carry an arrowhead.
  readonly fromEnd: 'none' | 'arrow'
  readonly toEnd: 'none' | 'arrow'
  /**
   * Draw the corners of `path` rounded rather than square. A rendering hint,
   * not geometry: `path` stays the single source of the edge's shape, so
   * sceneBounds, translateScene and scaleScene keep working on the points
   * alone. The backend's rounding is chosen to stay inside the polyline
   * (see its `<path>` construction), which is what makes that safe.
   */
  readonly rounded?: true
  readonly appearance?: Appearance
}

export type SceneNode =
  | HeadingBlockNode
  | ParagraphBlockNode
  | ListBlockNode
  | CodeBlockNode
  | BlockquoteNode
  | ThematicBreakNode
  | TableBlockNode
  | RawHtmlNode
  | UnresolvedReferenceNode
  | SvgFragmentNode
  | EmbedPlaceholderNode
  | EmbedResolvedNode
  | GroupSceneNode
  | TextRunNode
  | ResolvedEdgeNode
  | ShapeSceneNode
  | ImageSceneNode

/** A fully laid-out document: ordered top-level scene nodes in paint order. */
export interface Scene {
  readonly nodes: readonly SceneNode[]
}
