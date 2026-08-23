export { type ArrowPolygon, edgeArrowPolygons } from './edge-arrows.js'
export { flattenDrawnEdgePath } from './layout/edges/edge-flatten.js'
export { edgeLabelAnchor } from './layout/edges/edge-label-anchor.js'
export { flattenRoundedEdgePath } from './layout/edges/edge-rounding.js'
export {
  assignEdgeAnchors,
  type EdgeAnchorOverride,
  type EdgeAnchorPair,
  type EdgeSides,
  routeEdge,
} from './layout/edges/spatial-edges.js'
export * from './layout/embed-recursion.js'
export type {
  CodeToken,
  CodeTokenLines,
  CodeTokenRole,
  FittedBlocks,
  MdastLayoutOptions,
  RenderedSvgFragment,
} from './layout/nodes/mdast-blocks.js'
export {
  BODY_FONT_SIZE_PX,
  BODY_LINE_HEIGHT_PX,
  layoutMdastBlocks,
} from './layout/nodes/mdast-blocks.js'
export {
  type NodeOutline,
  nodeOutline,
  outlineContains,
  outlineEntryPoint,
} from './layout/nodes/node-outline.js'
export type {
  SpatialAppearanceResolver,
  SpatialNodeAppearance,
} from './layout/nodes/spatial-appearance.js'
export { scaleScene } from './layout/scale-scene.js'
export { createStyleRandom, seedFromId } from './layout/seed.js'
export type {
  FacetCardData,
  ResolvedReference,
  SpatialContentCache,
  SpatialLayoutDegradation,
  SpatialLayoutOptions,
} from './layout/spatial-canvas.js'
export {
  layoutSpatialCanvas,
  layoutSpatialCanvasWithAnchors,
  layoutSpatialEdges,
  naturalNodeContentSize,
} from './layout/spatial-canvas.js'
export { translateScene } from './layout/translate-scene.js'
export type { FontDescriptor, MeasureText, TextMetrics } from './measure.js'
export { clampAdvance, constantRatioMeasureText, isFullWidthCodePoint } from './measure.js'
export { MIN_SCENE_EXTENT_PX, sceneBounds } from './scene-bounds.js'
export type { SceneDigest } from './scene-digest.js'
export { sceneDigest, sceneDigestSchema } from './scene-digest.js'
export { sceneEntryKeys } from './scene-entry-keys.js'
export type {
  Appearance,
  BlockquoteNode,
  BoundingBox,
  CodeBlockNode,
  Dimensions,
  EmbedPlaceholderNode,
  EmbedResolvedNode,
  GlyphSceneNode,
  GroupSceneNode,
  HeadingBlockNode,
  IconSceneNode,
  LinkProvenance,
  ListBlockNode,
  ListItemNode,
  NodeOutlineKind,
  ParagraphBlockNode,
  RawHtmlNode,
  ResolvedEdgeNode,
  Scene,
  SceneNode,
  ShapeSceneNode,
  SvgFragmentNode,
  TableBlockNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
  ThematicBreakNode,
  UnresolvedReferenceNode,
} from './scene-graph.js'
export type { IconTable, SvgDocumentOptions } from './svg/backend.js'
export { renderSceneToSvg } from './svg/backend.js'
export { escapeXmlAttr, escapeXmlText, formatCoord } from './svg/format.js'
export type { KeyedSvgGroup, KeyedSvgRender } from './svg/keyed.js'
export { renderSceneToKeyedSvg } from './svg/keyed.js'
export { SPATIAL_THEME_FONT_FAMILY } from './theme/font-family.js'
export type { MarkdownTheme } from './theme/markdown-theme.js'
export { MARKDOWN_THEME_DOCUMENT, MARKDOWN_THEME_NODE } from './theme/markdown-theme.js'
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
export { createSpatialTheme } from './theme/spatial-theme.js'
export type { TidyMove, TidyNode, TidyOptions } from './tidy.js'
export { tidyNodes } from './tidy.js'
