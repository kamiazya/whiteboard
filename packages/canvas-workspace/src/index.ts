export { createAliasResolver } from './alias-resolver.js'
export type { CanvasIndexInput, WorkspaceIndexDeriveInput } from './derive-index.js'
export {
  deriveAliasHistoryRows,
  deriveAliasResolutionRows,
  deriveBacklinkRows,
  deriveCanvasListRows,
  deriveFacetIndexRows,
  deriveWorkspaceIndexRows,
} from './derive-index.js'
export { extractBacklinks } from './extract-backlinks.js'
export {
  deleteSpatialEdge,
  deleteSpatialNode,
  readCoreFacets,
  readFacets,
  readSpatialCanvas,
  type SpatialBatchWriter,
  withSpatialBatch,
  writeCoreFacets,
  writeFacets,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
} from './loro-bridge.js'
export type { WorkspaceNode, WorkspaceTreeSnapshot } from './workspace-tree.js'
export { WorkspaceTree } from './workspace-tree.js'
