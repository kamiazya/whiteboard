export type {
  CodecIssue,
  CodecParseError,
  CodecParseResult,
  CodecParseStage,
} from './errors.js'
export { normalizeMdast } from './markdown/normalize.js'
export {
  parseMarkdownBlockLines,
  parseMarkdownBody,
  stringifyMarkdownBody,
} from './markdown/pipeline.js'
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
export { okfMarkdownDocumentSchema, okfMarkdownFrontmatterSchema } from './okf/schema.js'
export { documentReferenceMarkup, referenceMarkup } from './references/markup.js'
export type { AliasResolver } from './references/resolve.js'
export { resolveReferences } from './references/resolve.js'
export type { DocumentPathResolver } from './references/resolve-for-export.js'
export { resolveReferencesForExport } from './references/resolve-for-export.js'
export {
  type CanvasRewriteResult,
  type DocumentMove,
  movesForPathChange,
  planReferenceRewrite,
  type ReferenceRewritePlanInput,
  rewriteCanvasReferences,
  rewriteReferenceTargets,
} from './references/rewrite.js'
export { findNextReference, type ReferenceMatch, scanReferences } from './references/scan.js'
export {
  createUniqueNameResolver,
  type UniqueNameEntry,
} from './references/unique-name-resolver.js'
export type { CensusFacet, SpatialModelCensus } from './spatial/census.js'
export { censusSpatialModel, jsonSchemaLeafPaths } from './spatial/census.js'
export type { JsonCanvasDocument, XWhiteboard } from './spatial/json-canvas.js'
export { jsonCanvasDocumentSchema } from './spatial/json-canvas.js'
export { xWhiteboardJsonSchema } from './spatial/json-schema.js'
export type { FieldProjection } from './spatial/projection.js'
export {
  fromJsonCanvas,
  JSON_CANVAS_PROJECTION,
  toJsonCanvas,
} from './spatial/projection.js'
export { readJsonCanvasText } from './spatial/read-json-canvas-text.js'
export type { SpatialCore } from './spatial/spatial-core.js'
export {
  installSpatialCore,
  parseSpatial,
  serializeSpatial,
  spatialCoreInstalled,
} from './spatial/spatial-core.js'
