export { type ArrowPolygon, edgeArrowPolygons } from './edge-arrows.js'
export { flattenDrawnEdgePath } from './layout/edge-flatten.js'
export { edgeLabelAnchor } from './layout/edge-label-anchor.js'
export { flattenRoundedEdgePath } from './layout/edge-rounding.js'
export * from './layout/embed-recursion.js'
export type { MdastLayoutOptions } from './layout/mdast-blocks.js'
export { BODY_FONT_SIZE_PX, layoutMdastBlocks } from './layout/mdast-blocks.js'
export { scaleScene } from './layout/scale-scene.js'
export type {
  SpatialAppearanceResolver,
  SpatialNodeAppearance,
} from './layout/spatial-appearance.js'
export type { SpatialLayoutDegradation, SpatialLayoutOptions } from './layout/spatial-canvas.js'
export { layoutSpatialCanvas, layoutSpatialEdges } from './layout/spatial-canvas.js'
export { assignEdgeAnchors, type EdgeSides, routeEdge } from './layout/spatial-edges.js'
export { translateScene } from './layout/translate-scene.js'
export type { FontDescriptor, MeasureText, TextMetrics } from './measure.js'
export { clampAdvance } from './measure.js'
export { MIN_SCENE_EXTENT_PX, sceneBounds } from './scene-bounds.js'
export type { SceneDigest } from './scene-digest.js'
export { sceneDigest, sceneDigestSchema } from './scene-digest.js'
export type {
  Appearance,
  BlockquoteNode,
  BoundingBox,
  CodeBlockNode,
  Dimensions,
  EmbedPlaceholderNode,
  EmbedResolvedNode,
  GroupSceneNode,
  HeadingBlockNode,
  LinkProvenance,
  ListBlockNode,
  ListItemNode,
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
export type { SvgDocumentOptions } from './svg/backend.js'
export { renderSceneToSvg } from './svg/backend.js'
export { escapeXmlAttr, escapeXmlText, formatCoord } from './svg/format.js'
export { SPATIAL_THEME_FONT_FAMILY } from './theme/font-family.js'
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
