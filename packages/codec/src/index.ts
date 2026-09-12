export type { CodecParseError, CodecParseResult, CodecParseStage } from './errors.js'
export { normalizeMdast } from './markdown/normalize.js'
export {
  parseMarkdownBlockLines,
  parseMarkdownBody,
  stringifyMarkdownBody,
} from './markdown/pipeline.js'
export { parseOkf } from './okf/parse.js'
export type {
  OkfMarkdownDocument,
  OkfMarkdownFrontmatter,
} from './okf/schema.js'
export { okfMarkdownDocumentSchema, okfMarkdownFrontmatterSchema } from './okf/schema.js'
export { serializeOkf } from './okf/serialize.js'
export { yamlSafeValueSchema } from './okf/yaml-safe.js'
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
export { type ReferenceMatch, scanReferences } from './references/scan.js'
export {
  createUniqueNameResolver,
  type UniqueNameEntry,
} from './references/unique-name-resolver.js'
export type { CensusFacet, SpatialModelCensus } from './spatial/census.js'
export { censusSpatialModel, jsonSchemaLeafPaths } from './spatial/census.js'
export { strictDegrade } from './spatial/degrade.js'
export type { JsonCanvasDocument, XWhiteboard } from './spatial/json-canvas.js'
export { jsonCanvasDocumentSchema } from './spatial/json-canvas.js'
export { xWhiteboardJsonSchema } from './spatial/json-schema.js'
export { parseSpatial } from './spatial/parse.js'
export type { FieldProjection, LossEntry } from './spatial/projection.js'
export {
  fromJsonCanvas,
  JSON_CANVAS_PROJECTION,
  jsonCanvasLoss,
  toJsonCanvas,
  valueLeafPaths,
} from './spatial/projection.js'
export type { SpatialSerializeMode } from './spatial/serialize.js'
export { serializeSpatial } from './spatial/serialize.js'
