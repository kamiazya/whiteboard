export * from './layout/embed-recursion.js'
export type { MdastLayoutOptions } from './layout/mdast-blocks.js'
export { layoutMdastBlocks } from './layout/mdast-blocks.js'
export { routeEdge } from './layout/spatial-edges.js'
export type { FontDescriptor, MeasureText, TextMetrics } from './measure.js'
export { clampAdvance } from './measure.js'
export type { SceneDigest } from './scene-digest.js'
export { sceneDigest, sceneDigestSchema } from './scene-digest.js'
export type {
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
  SvgFragmentNode,
  TableBlockNode,
  TableCellSceneNode,
  TableRowSceneNode,
  TextRunNode,
  ThematicBreakNode,
  UnresolvedReferenceNode,
} from './scene-graph.js'
export { renderSceneToSvg } from './svg/backend.js'
export { escapeXmlAttr, escapeXmlText, formatCoord } from './svg/format.js'
