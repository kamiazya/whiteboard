// The appearance seam for `layoutSpatialCanvas` (spatial-canvas.ts).
// canvas-render's layout functions deliberately never invent a fill/stroke/
// font (see `Appearance` in scene-graph.ts) — that decision belongs to the
// theme layer (`../theme/spatial-theme.ts`'s `createSpatialTheme`, the ONE
// producer of this interface; see package-canvas-render.md decision #8). A
// resolver is a set of FUNCTIONS rather than a static per-kind record
// because appearance keys off both `node.type` and an authored
// `node.color`/`x-whiteboard` hint. No default resolver is exported here —
// appearance stays assigned, not invented.
//
// This interface is APPEARANCE-ONLY. It deliberately has no
// paddingPx/labelFontSizePx/minContentWidthPx: those are geometry, not
// appearance, and geometry must not vary by which resolver a surface
// happens to use (see `../theme/spatial-geometry.ts` and the
// `spatial-geometry-parity.test.ts` guard). A caller that wants a
// non-default geometry passes `SpatialLayoutOptions.geometry` explicitly at
// the call site, never through this resolver.
import type { CanvasEdge, SpatialNode } from '@kamiazya/whiteboard-model'
import type { Appearance } from '../../scene-graph.js'
import type { SpatialSyntaxPalette } from '../../theme/spatial-palette.js'

/** What a resolver decided for one spatial node's chrome. */
export interface SpatialNodeAppearance {
  readonly appearance?: Appearance
  /** Uniform corner radius for the chrome shape; omitted means no radius. */
  readonly radius?: number
}

export interface SpatialAppearanceResolver {
  resolveNode(node: SpatialNode): SpatialNodeAppearance
  resolveEdge(edge: CanvasEdge): Appearance | undefined
  /** Appearance for a `file`/`link`/`group` label run or a degraded body fallback run. */
  resolveLabel(): Appearance
  /**
   * Fills for syntax-highlighted code runs, per role. Optional: a resolver
   * that answers nothing here renders code plain, which is the same
   * degradation as a caller that installs no highlighter at all — so the
   * absence assigns no appearance rather than inventing one.
   */
  resolveSyntax?(): SpatialSyntaxPalette
  /**
   * Chrome for the comment annotation layer (ADR-0024): the anchor pin and
   * the floating bubble behind the comment's text. Optional for the same
   * reason `resolveSyntax` is — a resolver that predates the layer still
   * lays comments out; they simply carry no appearance.
   */
  resolveComment?(): SpatialCommentAppearance
}

/**
 * The three shapes a comment composes, whichever visual treatment is
 * assigned to them — the unresolved default, or the resolved/muted overlay.
 */
export interface SpatialCommentChromeAppearance {
  readonly pin: Appearance
  readonly bubble: Appearance
  /** The dashed line tying pin to bubble, so the pair reads as one comment. */
  readonly leader: Appearance
  /**
   * The wash behind the words a thread quotes inside a text node (the text
   * arm naming a node). Optional: a resolver that predates passages still
   * lays them out, unpainted, the way a bare resolver lays pins out.
   */
  readonly passage?: Appearance
}

/** What a resolver decided for the comment layer's chrome. */
export interface SpatialCommentAppearance extends SpatialCommentChromeAppearance {
  /**
   * The muted treatment for a comment shown under `showResolved` (ADR-0025
   * decision 2 — resolved comments recede, never disappear from the toggle).
   * Required on the interface, unlike the rest of this file's optional
   * fields: a resolver that implements `resolveComment` at all must say what
   * a resolved comment looks like, or `composeComments` would have to invent
   * a muted appearance itself, which is exactly what this package's
   * appearance-is-assigned-not-invented rule forbids.
   */
  readonly resolvedOverlay: SpatialCommentChromeAppearance
}
