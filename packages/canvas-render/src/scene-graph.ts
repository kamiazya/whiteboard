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
  /**
   * Alpha applied to the fill. Distinct from folding the alpha into `fill`
   * because it is the only way to tint something whose colour is INHERITED:
   * a markdown body run carries no `fill` (see markdown-theme.ts), so a
   * muted run has to modulate whatever the host set rather than name a
   * colour of its own. Emitted as `fill-opacity`, which SVG 1.1 defines
   * for every renderer here including resvg — an 8-digit hex would not be.
   */
  readonly fillOpacity?: number
  /** Alpha applied to the stroke, for the same reason as `fillOpacity`. */
  readonly strokeOpacity?: number
  /**
   * Label underlay color (the canvas surface), so a label sitting ON an
   * edge line stays readable: the backend emits a stroke-only copy of the
   * text behind the fill text. Consumed for text runs only; absent keeps
   * the single-element output byte-identical.
   */
  readonly halo?: string
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
  /**
   * The run's text was CUT to fit — there is more of it than is painted.
   * Set by layout, honoured by the SVG backend as a fade over the run's
   * trailing edge. Deliberately not an ellipsis: a label is cut precisely
   * because width is scarce, and three dots spend the width they save.
   */
  readonly truncated?: true
  readonly appearance?: Appearance
  /**
   * A filled box painted BEHIND this run, inset from `bbox` by
   * `backdropPadXPx`. Inline code's tinted panel is the only user today.
   * Separate from `appearance` because that one paints the glyphs: a run
   * needs to name a background colour without naming a text colour, which
   * a single Appearance cannot express.
   */
  readonly backdrop?: Appearance
  /** Horizontal bleed (px) of `backdrop` past the run's own box. */
  readonly backdropPadXPx?: number
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
/**
 * Non-rect node silhouettes. `rect` is deliberately unrepresentable: an
 * absent `shape` field IS the rect, so a second spelling of it cannot
 * exist. Geometry derives from the bbox via `layout/nodes/node-outline.ts`.
 */
/**
 * A silhouette's NAMESPACED id (`visual.diamond`), resolved against the shape
 * table both layout and the SVG backend are handed. A name rather than the
 * geometry, because outlines derive from bbox + id — so `translateScene` needs
 * no knowledge of them and `scaleScene` scales them implicitly.
 */
export type ShapeId = string

export interface ShapeSceneNode {
  readonly kind: 'shape'
  /**
   * The node's content had to be cut to fit this box, so a reader is seeing
   * less than the document holds. Semantic provenance like `id`: the SVG
   * backend never emits it — the FADE on the last surviving run is the
   * painted half of the same fact — and `sceneDigest` reports it, which is
   * the only way a reader that is not looking at pixels can learn it.
   */
  readonly truncated?: true
  /**
   * The DOCUMENT node this chrome belongs to, when the scene was built from
   * one. Semantic provenance in the same sense as a heading's `level` — the
   * SVG backend never emits it, but `sceneDigest` needs it to name what it
   * reports something the reader can actually address (a `node.patch` op
   * takes a node id, not a position in a list). Optional because a scene
   * can be built by hand, and a chrome rect drawn for something that is not
   * a document node has no id to give.
   */
  readonly id?: string
  readonly bbox: BoundingBox
  /** Uniform corner radius. Non-finite or <= 0 omits `rx` entirely.
   * Applies to the rect form only — ignored when `shape` is set. */
  readonly radius?: number
  /**
   * Non-rect silhouette, derived at draw time from `bbox` by the shared
   * decomposition in `layout/nodes/node-outline.ts` (one producer for drawing
   * AND hit-testing). Absent = the historic rect, byte-identical to
   * before this field existed. A kind, never stored coordinates, so
   * translate/scale need no knowledge of it.
   */
  readonly shape?: ShapeId
  readonly appearance?: Appearance
}

/**
 * A vendored-icon glyph (the visual plugin's table) drawn at `bbox` via a shared
 * `<symbol>` definition and a per-node `<use>` reference — one definition
 * per icon name regardless of how many nodes show it. `icon` names an
 * entry in the vendored table; an unknown name degrades to nothing, per
 * the never-throw rule. A bbox-only leaf for bounds/translate/scale, like
 * `ImageSceneNode`.
 */
export interface IconSceneNode {
  readonly kind: 'icon'
  readonly bbox: BoundingBox
  readonly icon: string
  readonly appearance?: Appearance
}

/**
 * A character badge drawn as one centered text glyph sized to `bbox` (the
 * smaller side). Intended for a single visual glyph — an emoji (including
 * multi-codepoint ZWJ/flag/skin-tone clusters, which SVG text renders as
 * one glyph with no handling here), a CJK character, a dingbat. Longer
 * text still renders, centered, and may overflow the box by design — prose
 * belongs in text runs, not badges. Color comes from the font itself, so
 * unlike `IconSceneNode` there is no appearance to assign. A bbox-only
 * leaf for bounds/translate/scale, like `ImageSceneNode`. Rendering
 * depends on the host's fonts: the resvg PNG export path ships only a
 * Roboto face, so emoji degrade to that font's fallback glyph there.
 */
export interface GlyphSceneNode {
  readonly kind: 'glyph'
  readonly bbox: BoundingBox
  readonly glyph: string
}

/** Semantic provenance for an inline link-like run. Never flattened away. */
export type LinkProvenance =
  | { readonly kind: 'link'; readonly href: string; readonly title?: string }
  | { readonly kind: 'wikiLink'; readonly documentId: string; readonly alias?: string }
  | { readonly kind: 'embed'; readonly documentId: string }

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
  /** The fence's source, kept verbatim for provenance and copy. */
  readonly value: string
  readonly lang?: string
  /**
   * One run per SOURCE line, already positioned. SVG `<text>` collapses a
   * newline to a space, so a single element carrying `value` paints the
   * whole fence on one line inside a box sized for many — the runs are what
   * make a fence render as a fence.
   */
  readonly runs?: readonly TextRunNode[]
  /** Panel painted behind `runs`, filling `bbox`. */
  readonly appearance?: Appearance
  /** Corner radius (px) of that panel. */
  readonly radius?: number
}

export interface BlockquoteNode {
  readonly kind: 'blockquote'
  readonly bbox: BoundingBox
  /** The quoted blocks, preceded by the accent bar as a `shape`. */
  readonly children: readonly SceneNode[]
  /** Applied to the group, so quoted prose inherits a muted fill. */
  readonly appearance?: Appearance
}

export interface ThematicBreakNode {
  readonly kind: 'thematicBreak'
  readonly bbox: BoundingBox
  readonly appearance?: Appearance
}

export interface TableCellSceneNode {
  readonly kind: 'tableCell'
  readonly bbox: BoundingBox
  readonly runs: readonly TextRunNode[]
  /** Cell border, drawn as a stroked rect over `bbox`. */
  readonly appearance?: Appearance
}

export interface TableRowSceneNode {
  readonly kind: 'tableRow'
  readonly bbox: BoundingBox
  readonly cells: readonly TableCellSceneNode[]
  /** True for the header row, whose cells are laid out bold. */
  readonly header?: boolean
  /**
   * Hairline separator along the row's BOTTOM edge — the whole of a table's
   * chrome. Absent on the last row, which needs no line under it.
   */
  readonly appearance?: Appearance
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
  readonly documentId: string
  readonly title: string
  readonly reason: 'cycle' | 'depthCap' | 'unresolvable'
}

export interface EmbedResolvedNode {
  readonly kind: 'embedResolved'
  readonly bbox: BoundingBox
  readonly documentId: string
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
  /**
   * How the image meets its frame: 'contain' letterboxes (the default,
   * preserving the pre-fit output byte-for-byte), 'cover' fills and crops.
   * Maps to SVG preserveAspectRatio meet/slice.
   */
  readonly fit?: 'contain' | 'cover'
}

export interface GroupSceneNode {
  readonly kind: 'group'
  readonly bbox: BoundingBox
  readonly label?: string
  readonly children: readonly SceneNode[]
}

/** A point where this edge hops over an earlier edge, on path segment `segment`. */
export interface EdgeJumpPoint {
  readonly segment: number
  readonly x: number
  readonly y: number
}

export interface ResolvedEdgeNode {
  readonly kind: 'edge'
  readonly id: string
  /**
   * Line-jump hops, present only when the canvas enables them. Bounds keep
   * reading the raw `path` (the deviation is bounded by the jump radius);
   * the editor's hit/highlight path follows the drawn hops via
   * `flattenDrawnEdgePath`, the same decomposition the SVG backend
   * serializes.
   */
  readonly jumps?: readonly EdgeJumpPoint[]
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
  | IconSceneNode
  | GlyphSceneNode

/** A fully laid-out document: ordered top-level scene nodes in paint order. */
export interface Scene {
  readonly nodes: readonly SceneNode[]
}
