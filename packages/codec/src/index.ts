export { normalizeMdast } from './markdown/normalize.js'
export { parseMarkdownBody } from './markdown/pipeline.js'
export { hasOkfFrontmatter } from './okf/has-frontmatter.js'
export type { OkfCore } from './okf/okf-core.js'
export {
  installOkfCore,
  OkfNotYamlSafeError,
  okfCoreInstalled,
  parseOkf,
  serializeOkf,
} from './okf/okf-core.js'
export type {
  OkfMarkdownDocument,
  OkfMarkdownFrontmatter,
} from './okf/schema.js'
export { okfMarkdownFrontmatterSchema } from './okf/schema.js'
export { documentReferenceMarkup, referenceMarkup } from './references/markup.js'
export type { AliasResolver } from './references/resolve.js'
export { resolveReferences } from './references/resolve.js'
export {
  type DocumentMove,
  movesForPathChange,
  planReferenceRewrite,
  rewriteCanvasReferences,
  rewriteReferenceTargets,
} from './references/rewrite.js'
export { findNextReference, scanReferences } from './references/scan.js'
export {
  createUniqueNameResolver,
  type UniqueNameEntry,
} from './references/unique-name-resolver.js'
export type { CensusFacet } from './spatial/census.js'
export { censusSpatialModel } from './spatial/census.js'
export { jsonCanvasDocumentSchema } from './spatial/json-canvas.js'
export type { FieldProjection } from './spatial/projection.js'
export {
  fromJsonCanvas,
  JSON_CANVAS_PROJECTION,
  toJsonCanvas,
} from './spatial/projection.js'
export type { SpatialCore } from './spatial/spatial-core.js'
export {
  installSpatialCore,
  parseSpatial,
  serializeSpatial,
  spatialCoreInstalled,
} from './spatial/spatial-core.js'
