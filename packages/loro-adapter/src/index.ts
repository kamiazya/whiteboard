export {
  RetiredCommentPlaneError,
  readAnnotations,
  retiredCommentRows,
} from './annotations.js'
export {
  moveCommentThread,
  readCommentThreads,
  setCommentThreadStatus,
  writeCommentThread,
  writeThreadMessage,
} from './comment-threads.js'
export type { DocumentContainers } from './containers.js'
export { MARKDOWN_BODY_KEY, NODES_KEY } from './containers.js'
export { contentDigestOfDocument } from './content-digest.js'
export { directTarget, type WriteTarget } from './direct-target.js'
export { type DocumentBatchWriter, withDocumentBatch } from './document-batch.js'
export {
  type ContentWithTags,
  type DocumentContent,
  readContentWithTags,
  readDocumentContent,
} from './document-content.js'
export {
  applyDocumentEdit,
  type DocumentEdit,
  documentEditWrites,
  type TextSplice,
} from './document-edit.js'
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
export { type CrdtEngineOptions, createCrdtEngine } from './engine/engine.js'
export { type JournaledEngine, journaledEngine } from './engine/journal.js'
export type { LeaseVersion, RecordLease } from './engine/lease.js'
export * as lease from './engine/lease.js'
export {
  type LeaseFileReferenceReads,
  scanFileReferencesOfLease,
} from './engine/lease-file-references.js'
export { type LeaseKindOptions, leaseKind } from './engine/lease-kind.js'
export { leaseOps } from './engine/lease-ops.js'
export { loadCrdtEngine, sharedCrdtEngine } from './engine/load.js'
export { randomPeerId } from './engine/peer.js'
export { readValue } from './engine/read-value.js'
export type { CrdtEngine } from './engine/types.js'
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
export { type LegacyRecord, loroDocKind } from './legacy-record-kind.js'
export { legacyRecordOps } from './legacy-record-ops.js'
export {
  CONTENT_CONTAINER_KEYS,
  deleteSpatialEdge,
  deleteSpatialNode,
  readEdgeLocks,
  readNodeLocks,
  readSpatialCanvas,
  readSpatialCanvasWithSkipped,
  reconcileSpatialCanvas,
  setEdgeLock,
  setNodeLock,
  withSpatialBatch,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
} from './loro-bridge.js'
export { readMarkdownBody, writeMarkdownBody } from './markdown-body.js'
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
export { RecordBytesRejectedError, type RecordKind } from './record-kind.js'
export {
  bindRecordOps,
  type RecordOps,
  type RecordSession,
  type RecordVersion,
  type RecordView,
} from './record-ops.js'
export { documentsRemovedSince, type RemovedDocument } from './removed-documents.js'
export { ReservedKeyWriteError } from './reserved-key-write.js'
export { RetiredStoredShapeError, retiredStoredShapeIn } from './retired-stored-shape.js'
export { countSpatialNodes } from './spatial-node-count.js'
export { stateSize } from './state-size.js'
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
  folderNamesByPath,
  namedFoldersAbove,
  readWorkspaceFolderNames,
  reapplyFolderNames,
  setWorkspaceFolderName,
} from './workspace-folder-name.js'
export {
  isWorkspaceSyncBreach,
  judgeWorkspaceSyncImport,
  SYNC_WORKSPACE_BREACH_CODES,
  type WorkspaceSyncBreach,
} from './workspace-sync-limits.js'
export {
  forgetTrashEntry,
  readTrashEntries,
  recordTrashEntry,
  type TrashEntry,
  trashEntrySchema,
  WORKSPACE_TRASH_KEY,
} from './workspace-trash.js'
export {
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
