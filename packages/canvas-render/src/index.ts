export * from './layout/embed-recursion.js'
export type { MdastLayoutOptions } from './layout/mdast-blocks.js'
export { layoutMdastBlocks } from './layout/mdast-blocks.js'
export type {
  SpatialAppearanceResolver,
  SpatialNodeAppearance,
} from './layout/spatial-appearance.js'
export type { SpatialLayoutDegradation, SpatialLayoutOptions } from './layout/spatial-canvas.js'
export { layoutSpatialCanvas } from './layout/spatial-canvas.js'
export { routeEdge } from './layout/spatial-edges.js'
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
