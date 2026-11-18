/**
 * What a run of body text DRAWS as, which is not what a document stores.
 * Published because a caller that has to reason about the drawn glyphs —
 * the export's undrawable-character report is the one that exists — cannot
 * get there from the stored string, and a second copy of the rule is how
 * that report comes to disagree with the picture.
 */
export { expandEmojiShortcodes } from '@kamiazya/whiteboard-plugin-visual/emoji/shortcode'
export type {
  Appearance,
  BlockquoteNode,
  BoundingBox,
  CodeBlockNode,
  EmbedPlaceholderNode,
  EmbedResolvedNode,
  GlyphSceneNode,
  GroupSceneNode,
  HeadingBlockNode,
  IconSceneNode,
  LegendEntry,
  LegendKey,
  LegendSwatch,
  LinkProvenance,
  ListBlockNode,
  ListItemNode,
  RawHtmlNode,
  ResolvedEdgeNode,
  Scene,
  SceneInk,
  SceneLegend,
  SceneNode,
  ShapeSceneNode,
  SvgFragmentNode,
  TableBlockNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
  ThematicBreakNode,
  UnresolvedReferenceNode,
} from '@kamiazya/whiteboard-scene'
export type {
  CanvasLayoutCore,
  CanvasLayoutRequest,
  CoreDegradation,
  CoreSvgAsk,
} from './canvas-core.js'
export { selectCanvasFragment } from './canvas-fragment.js'
export {
  type KeyedPicture,
  layoutCommentDocumentKeyedPicture,
  layoutMarkdownDocumentKeyedPicture,
  layoutMarkdownDocumentPicture,
  layoutSpatialCanvasKeyedPicture,
  layoutSpatialCanvasPicture,
  layoutSpatialEdgesPicture,
  type PicturedScene,
} from './core-picture.js'
export { type ArrowPolygon, edgeArrowPolygons } from './edge-arrows.js'
export { flattenDrawnEdgePath } from './edge-path/edge-flatten.js'
export { flattenRoundedEdgePath } from './edge-path/edge-rounding.js'
export {
  createRoutingBudget,
  type EdgeAnchorOverride,
  type EdgeAnchorPair,
  type EdgeSides,
} from './edge-routing.js'
export {
  type FragmentAsk,
  type FragmentEntry,
  fragmentAskKey,
  fragmentAskSchema,
  type RenderedSvgFragment,
} from './fragment-ask.js'
export type { CodeToken, CodeTokenLines, CodeTokenRole } from './highlight/code-token.js'
export { boxContains, type HitBox, hitBoxesOf, topmostHit } from './hit-test.js'
export { GLOW_STD_DEVIATION_RATIO, glowReachPx } from './ink/glow.js'
export { styleRandomFromSeed } from './ink/seed.js'
export {
  SKETCH_INK_REACH_PX,
  type SketchEdgeOptions,
  type SketchInk,
  sketchEdge,
  sketchShape,
} from './ink/sketch.js'
export { CoreUnaskable } from './layout/canvas-switch.js'
export {
  resolveCanvasPalette,
  resolveCanvasThemeFontFamily,
  resolveThemeTable,
} from './layout/canvas-theme.js'
export { fittedTextNodeHeight } from './layout/fitted-height.js'
export {
  type CommentDocumentOptions,
  layoutCommentDocument,
  layoutMarkdownDocument,
  type MarkdownDocumentOptions,
} from './layout/markdown-switch.js'
export {
  type LabelObstacle,
  queryCommentBubble,
  queryEdgeLabelPlacement,
  queryLabelObstacles,
  queryOutlineContentBox,
} from './layout/queries.js'
export { layoutSceneDigest } from './layout/query-switch.js'
export type {
  SpatialContentCache,
  SpatialLayoutDegradation,
  SpatialLayoutOptions,
  SpatialRenderStyle,
} from './layout/spatial-canvas.js'
export {
  COMMENT_BUBBLE_PADDING_PX,
  COMMENT_BUBBLE_RADIUS_PX,
  COMMENT_TEXT_MAX_WIDTH_PX,
  commentAnchor,
  type EdgePathLookup,
  layoutSpatialCanvas,
  layoutSpatialCanvasWithAnchors,
  layoutSpatialEdges,
  naturalNodeContentSize,
  spatialRenderStyleSchema,
} from './layout/spatial-canvas.js'
export { type LayoutCore, type RoutingCore, routeLayout } from './layout-core.js'
export { legendValueLabel } from './legend/legend-geometry.js'
export type {
  MarkdownCommentRequest,
  MarkdownLayoutCore,
  MarkdownNoteRequest,
} from './markdown-core.js'
export type { FontDescriptor, MeasureSpec, MeasureText, TextMetrics } from './measure.js'
export {
  clampAdvance,
  constantRatioMeasureText,
  describeMeasure,
  isFullWidthCodePoint,
  measureSpecOf,
} from './measure.js'
export { type NodeOutline, nodeOutline } from './outline/node-outline.js'
export { paintOrderOf } from './paint-order.js'
export {
  CANVAS_VIEW_PICTURE_META_KEY,
  type CanvasViewPicture,
  canvasViewPictureSchema,
} from './picture/canvas-view-picture.js'
export type {
  QueryAnswer,
  QueryLayoutCore,
  QueryRequest,
} from './query-core.js'
export {
  createReferenceContentAccount,
  REFERENCE_CHARS_BUDGET,
  REFERENCE_ELEMENTS_BUDGET,
  type ReferenceContentAccount,
} from './references/content-budget.js'
export type { LoadedReference, ReferenceGraph } from './references/loaded-reference.js'
export type {
  EmbeddedDocument,
  FacetCardData,
  ResolvedReference,
} from './references/resolved.js'
export {
  type ReferenceSeams,
  type ReferenceSeamsOptions,
  referenceSeams,
} from './references/seams.js'
export {
  imageTargets,
  type ReferenceSeeds,
  referenceTargets,
  type WalkReferencesOptions,
  walkReferences,
  walkReferencesSync,
  writtenTargets,
} from './references/targets.js'
export {
  overlayReferences,
  type ReferenceExtra,
  type ReferenceWire,
  type ReferenceWireOptions,
  referenceSeamsFromWire,
  referenceWire,
  referenceWireFor,
} from './references/wire.js'
export {
  type LoadedReferenceWire,
  loadedReferenceFromWire,
  loadedReferenceToWire,
  loadedReferenceWireSchema,
} from './references/wire-schema.js'
export { type LayoutRefusal, refusalCopy, refusalScene } from './refusal.js'
export { MIN_SCENE_EXTENT_PX, sceneBounds, sceneDocumentBounds } from './scene-bounds.js'
export type { SceneWalkNode } from './scene-children.js'
export { sceneChildrenOf } from './scene-children.js'
export type { SceneDigest } from './scene-digest-schema.js'
export { sceneDigestSchema } from './scene-digest-schema.js'
export { STROKE_WEIGHT_FACTOR } from './stroke-weight.js'
export type { SvgDocumentOptions } from './svg/backend.js'
export { renderSceneToSvg } from './svg/backend.js'
export { documentIdOfHref } from './svg/document-href.js'
export { formatCoord } from './svg/format.js'
export type { IconTable } from './svg/icon.js'
export type { KeyedSvgGroup, KeyedSvgRender } from './svg/keyed.js'
export { renderSceneToKeyedSvg } from './svg/keyed.js'
/**
 * Exported because a caller that SCORES a canvas must score the one the
 * layout would draw, not the one the store holds: `layoutSpatialCanvas`
 * resolves a declared tag colour onto the node before it lays anything out,
 * so a scorer that skips this step reads `colour unused` on a board drawn in
 * two colours. The eval lane's two-axis verifier did exactly that and failed
 * boards a reader would call correct (ADR-0031's twenty-fourth reading).
 */
export { withDeclaredColours } from './tags/declared-colours.js'
export { SPATIAL_THEME_FONT_FAMILY, SPATIAL_THEME_FONT_STACK } from './theme/font-family.js'
export type { MarkdownTheme } from './theme/markdown-theme.js'
export { BODY_FONT_SIZE_PX, BODY_LINE_HEIGHT_PX } from './theme/markdown-theme.js'
export type {
  SpatialAppearanceResolver,
  SpatialNodeAppearance,
} from './theme/spatial-appearance.js'
export type { SpatialGeometry } from './theme/spatial-geometry.js'
export { SPATIAL_THEME_GEOMETRY } from './theme/spatial-geometry.js'
export type {
  SpatialNodeStyle,
  SpatialPalette,
  SpatialPresetAccent,
  SpatialPresetKey,
} from './theme/spatial-palette.js'
export { SPATIAL_DARK_PALETTE, SPATIAL_LIGHT_PALETTE } from './theme/spatial-palette.js'
export type { SpatialThemeMode, SpatialThemeOptions } from './theme/spatial-theme.js'
export { createSpatialTheme, spatialThemeModeSchema } from './theme/spatial-theme.js'
export { paletteFromTokens } from './theme/theme-asset.js'
export { type ThemeFont, themeFontSchema } from './theme/theme-font.js'
export { tidyBoxes, tidyNodes } from './tidy.js'
export { escapeXmlAttr, escapeXmlText } from './xml-escape.js'
