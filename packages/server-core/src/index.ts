export { createServer } from './create-server.js'
export type { Logger, LogSink } from './log.js'
export { getLogger, setLogSink } from './log.js'
export type { Embedder } from './search/embedder.js'
export type {
  AgentActivity,
  CanvasClientNotifier,
  ServerDeps,
  ViewportRequest,
} from './server-deps.js'
export type { BacklinksInput, BacklinksOutput } from './tools/backlinks.js'
export { backlinksInputSchema, backlinksOutputSchema, computeBacklinks } from './tools/backlinks.js'
export type { BodyPatchInput, BodyPatchOutput, BodyPatchRange } from './tools/body-patch.js'
export {
  bodyPatchInputSchema,
  bodyPatchOutputSchema,
  bodyPatchRangeSchema,
  createBodyPatchTool,
} from './tools/body-patch.js'
export { createCanvasEditTool } from './tools/canvas-edit.js'
export type { CanvasRenderSvgInput, CanvasRenderSvgOutput } from './tools/canvas-render-svg.js'
export {
  canvasRenderSvgInputSchema,
  canvasRenderSvgOutputSchema,
  createCanvasRenderSvgTool,
} from './tools/canvas-render-svg.js'
export type { CanvasViewInput, CanvasViewOutput } from './tools/canvas-view.js'
export {
  canvasViewInputSchema,
  canvasViewOutputSchema,
  canvasViewReferenceSchema,
  createCanvasViewTool,
} from './tools/canvas-view.js'
export {
  WorkspaceDocumentNotFoundError,
  WorkspaceNotFoundError,
} from './tools/document-crud.errors.js'
export {
  wbDocumentCreate,
  wbDocumentDelete,
  wbDocumentList,
  wbDocumentResolve,
} from './tools/document-crud.js'
export {
  WB_DOCUMENT_CREATE_DESCRIPTION,
  WB_DOCUMENT_DELETE_DESCRIPTION,
  WB_DOCUMENT_LIST_DESCRIPTION,
  WB_DOCUMENT_RESOLVE_DESCRIPTION,
  wbDocumentCreateInputSchema,
  wbDocumentCreateOutputSchema,
  wbDocumentDeleteInputSchema,
  wbDocumentDeleteOutputSchema,
  wbDocumentListInputSchema,
  wbDocumentListOutputSchema,
  wbDocumentResolveInputSchema,
  wbDocumentResolveOutputSchema,
} from './tools/document-crud.schemas.js'
export { SnapshotNotFoundError } from './tools/document-io.js'
export type { DocumentSearchInput, DocumentSearchOutput } from './tools/document-search.js'
export {
  createDocumentSearchTool,
  documentSearchInputSchema,
  documentSearchOutputSchema,
} from './tools/document-search.js'
export type { DocumentSetInput, DocumentSetOutput } from './tools/document-set.js'
export {
  createDocumentSetTool,
  documentSetInputSchema,
  documentSetOutputSchema,
  OkfParseError,
} from './tools/document-set.js'
export type { DocumentTagsInput, DocumentTagsOutput } from './tools/document-tags.js'
export {
  computeDocumentTags,
  documentTagsInputSchema,
  documentTagsOutputSchema,
} from './tools/document-tags.js'
export {
  NodeNotFoundError,
  NotATextNodeError,
  PatchValidationError,
} from './tools/errors.js'
export type {
  ExportJsonCanvasInput,
  ExportJsonCanvasOutput,
} from './tools/export-json-canvas.js'
export {
  exportJsonCanvas,
  exportJsonCanvasInputSchema,
  exportJsonCanvasOutputSchema,
} from './tools/export-json-canvas.js'
export type { ExportOkfInput, ExportOkfOutput } from './tools/export-okf.js'
export {
  exportOkf,
  exportOkfInputSchema,
  exportOkfOutputSchema,
} from './tools/export-okf.js'
export {
  createFacetListTool,
  facetListInputSchema,
  facetListOutputSchema,
} from './tools/facet-list.js'
export type { FacetSetInput, FacetSetOutput } from './tools/facet-set.js'
export { createFacetSetTool, facetSetInputSchema, facetSetOutputSchema } from './tools/facet-set.js'
export type { LinkifyMentionsInput, LinkifyMentionsOutput } from './tools/linkify-mentions.js'
export {
  linkifyMentions,
  linkifyMentionsInputSchema,
  linkifyMentionsOutputSchema,
  NamelessLinkifyTargetError,
} from './tools/linkify-mentions.js'
export type { VersionListInput, VersionListOutput } from './tools/version-list.js'
export {
  createVersionListTool,
  versionListInputSchema,
  versionListOutputSchema,
} from './tools/version-list.js'
export type { VersionRestoreInput, VersionRestoreOutput } from './tools/version-restore.js'
export {
  createVersionRestoreTool,
  VersionNotFoundError,
  versionRestoreInputSchema,
  versionRestoreOutputSchema,
} from './tools/version-restore.js'
export type { VersionSaveInput, VersionSaveOutput } from './tools/version-save.js'
export {
  createVersionSaveTool,
  versionSaveInputSchema,
  versionSaveOutputSchema,
} from './tools/version-save.js'
