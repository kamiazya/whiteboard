export { readAnnotations, readCanvasComments } from './annotations.js'
export {
  migrateCanvasCommentsToThreads,
  readCommentThreads,
  setCommentThreadStatus,
  storedThreadMessageCount,
  writeCommentThread,
  writeThreadMessage,
} from './comment-threads.js'
export type { DocumentContainers } from './containers.js'
export { MARKDOWN_BODY_KEY, NODES_KEY } from './containers.js'
export { contentDigestOfDocument } from './content-digest.js'
export { type DocumentBatchWriter, withDocumentBatch } from './document-batch.js'
export { type DocumentContent, readDocumentContent } from './document-content.js'
export {
  readCoreFacets,
  readDocumentKind,
  readFacets,
  readTrustFacets,
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeTrustFacets,
} from './document-envelope.js'
export { reconcileCoreFacets, reconcileFacets } from './document-envelope-reconcile.js'
export { rootsNoDocumentNodeHolds } from './document-node-roots.js'
export { isEngineTrap } from './engine-trap.js'
export { type EnvelopeKindBreach, envelopeKindBreach, statedKindSplit } from './envelope-kind.js'
export {
  DEFAULT_FILE_GRACE_MS,
  type FileReferenceHolder,
  type FileReferenceReads,
  scanFileReferences,
  type UnjudgedFileHolder,
} from './file-references.js'
export { collectImageRefIds } from './image-refs.js'
export {
  CONTENT_CONTAINER_KEYS,
  deleteCanvasComment,
  deleteSpatialEdge,
  deleteSpatialNode,
  readEdgeLocks,
  readNodeLocks,
  readSpatialCanvas,
  readSpatialCanvasWithSkipped,
  reconcileSpatialCanvas,
  type SpatialBatchWriter,
  setEdgeLock,
  setNodeLock,
  withSpatialBatch,
  writeCanvasComment,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
} from './loro-bridge.js'
export { MARKDOWN_BODY_NODE_ID, readMarkdownBody, writeMarkdownBody } from './markdown-body.js'
export { type MinimalChange, minimalChange } from './minimal-change.js'
export {
  readWorkspaceDocumentName,
  seedNameFromTitle,
  seedNamesFromTitles,
  writeDocumentContentAndName,
} from './name-from-title.js'
export {
  readProposals,
  setProposedChangeStatus,
  writeProposal,
} from './proposals.js'
export { documentsRemovedSince, type RemovedDocument } from './removed-documents.js'
export { countSpatialNodes } from './spatial-node-count.js'
export { holdsContainerCreation } from './sync-structure-limits.js'
export {
  importWithinTextLimits,
  judgeStateWithinTextLimits,
  SYNC_TEXT_BREACH_CODES,
  type SyncTextBreach,
  type SyncTextJudgement,
  syncTextLimitJudge,
  UnjudgedImportError,
} from './sync-text-limits.js'
export {
  markThreadPassages,
  type PassageRange,
  readThreadMarks,
} from './thread-marks.js'
export {
  documentsTouchedSince,
  organisationChangedSince,
  stampEditedDocuments,
  type TouchedDocument,
} from './touched-documents.js'
export { duplicateWorkspaceDocument } from './workspace-duplicate.js'
export {
  forgetTrashEntry,
  readTrashEntries,
  recordTrashEntry,
  type TrashEntry,
  trashEntrySchema,
  WORKSPACE_TRASH_KEY,
} from './workspace-trash.js'
export {
  adoptWorkspaceDocument,
  type CreateWorkspaceDocumentInput,
  createWorkspaceDocument,
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  deleteWorkspaceNodeAtPath,
  documentContainers,
  exportWorkspaceSubtree,
  importWorkspaceSubtree,
  moveWorkspaceDocument,
  moveWorkspaceNodeToPath,
  projectWorkspaceDocument,
  pruneEmptyFolders,
  readPinnedDocumentIds,
  readWorkspaceDocuments,
  readWorkspaceMeta,
  readWorkspaceNodes,
  reconcileDocContent,
  resolveWorkspaceDocument,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
  setWorkspaceLastCompactedAt,
  setWorkspacePinned,
  unreadableWorkspaceNodes,
  updateWorkspaceDocumentMeta,
  WORKSPACE_META_KEY,
  WORKSPACE_TREE_KEY,
  type WorkspaceDocumentEntry,
  type WorkspaceDocumentMetaPatch,
  type WorkspaceMeta,
  type WorkspaceNode,
  type WorkspaceNodeMeta,
  workspaceFolderMetaSchema,
  workspaceMetaSchema,
  workspaceNodeMetaSchema,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'
export { descendsFromWorkspaceTree } from './workspace-tree-descent.js'
