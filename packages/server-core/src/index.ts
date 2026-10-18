export type { ApiErrorBody } from './api-errors.js'
export {
  apiErrorBodySchema,
  apiErrorReason,
  errorBody,
  invalidRequestBody,
  issueText,
} from './api-errors.js'
export { answerUnhandled, createServer } from './create-server.js'
export { DocumentEngineTrapError } from './document-io.js'
export { setLogSink } from './log.js'
export {
  applyDocumentUpdate,
  DocumentCreationRefusedError,
} from './operations/apply-document-update.js'
export { applyWorkspaceDocumentUpdate } from './operations/apply-workspace-document-update.js'
export { promoteWorkspace } from './operations/promote-workspace.js'
export type { RestoreProgress } from './operations/restore-version.js'
export { restoreVersion } from './operations/restore-version.js'
export { syncWriteAnswer } from './operations/sync-write-refusals.js'
export { unknownStyleRefusal } from './render/unknown-style.js'
export type { Embedder } from './search/embedder.js'
export type { Judgments } from './search/eval.js'
export {
  bootstrapCi,
  ndcgAt,
  pairedPermutationTest,
  permutationFloor,
  randomBaseline,
  recallAt,
  reciprocalRank,
  requiredQueryCount,
  standardDeviation,
} from './search/eval.js'
export type { QueryCategory } from './search/search-corpus.js'
export type {
  AdoptedVersion,
  AgentActivity,
  CanvasClientNotifier,
  DocumentTeardown,
  DocumentWritten,
  LiveDocuments,
  RestoreProgressEvent,
  ServerDeps,
  VersionCreated,
  VersionHistory,
  WorkspaceDocuments,
} from './server-deps.js'
export { createCanvasEditTool } from './tools/canvas-edit.js'
export { createCanvasRenderSvgTool } from './tools/canvas-render-svg.js'
export { WorkspaceNotFoundForCallerError } from './tools/document-crud.errors.js'
export {
  wbDocumentCreate,
  wbDocumentDelete,
  wbDocumentList,
} from './tools/document-crud.js'
export {
  type WbDocumentMoveResult,
  wbDocumentMove,
} from './tools/document-move.js'
export { createDocumentSearchTool } from './tools/document-search.js'
export { createDocumentSetOperation } from './tools/document-set.js'
export { drawsATag, TAG_LIBRARY_PATH } from './tools/tag-library.js'
export type {
  Attestation,
  OperatorInfo,
} from './versions/version-entry.js'
export { attestationSchema } from './versions/version-entry.js'
export type {
  ViewportRequest,
  ViewportRequestParams,
} from './viewport-request.js'
