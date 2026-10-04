export type { ApiErrorBody } from './api-errors.js'
export {
  apiErrorBodySchema,
  apiErrorReason,
  errorBody,
  invalidRequestBody,
  issueText,
} from './api-errors.js'
export { answerUnhandled, createServer } from './create-server.js'
export { isEngineTrap } from './document-io.js'
export { getLogger, setLogSink } from './log.js'
export { applyDocumentUpdate } from './operations/apply-document-update.js'
export { applyWorkspaceDocumentUpdate } from './operations/apply-workspace-document-update.js'
export { promoteWorkspace } from './operations/promote-workspace.js'
export type { RestoreProgress } from './operations/restore-version.js'
export { restoreVersion } from './operations/restore-version.js'
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
export { canvasEditInputSchema, createCanvasEditTool } from './tools/canvas-edit.js'
export { createCanvasRenderSvgTool } from './tools/canvas-render-svg.js'
// The snapshot's own shape, exported for the same reason every other tool's
// schemas here are: a reader outside this package needs the one declaration
// of what a board read answers, rather than a second description of it.
export { canvasSnapshotSchema } from './tools/canvas-snapshot.js'
export {
  canvasViewInputSchema,
  canvasViewOutputSchema,
  createCanvasViewTool,
} from './tools/canvas-view.js'
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
export { createDocumentSetTool } from './tools/document-set.js'
export { createFacetListTool } from './tools/facet-list.js'
export { carriesATag, TAG_LIBRARY_PATH } from './tools/tag-library.js'
export { createVersionListTool } from './tools/version-list.js'
export {
  createVersionRestoreTool,
  versionRestoreOutputSchema,
} from './tools/version-restore.js'
export { createVersionSaveTool } from './tools/version-save.js'
export { createWorkspaceEditTool } from './tools/workspace-edit.js'
export type {
  Attestation,
  OperatorInfo,
} from './versions/version-entry.js'
export { attestationSchema } from './versions/version-entry.js'
export type {
  ViewportRequest,
  ViewportRequestParams,
} from './viewport-request.js'
