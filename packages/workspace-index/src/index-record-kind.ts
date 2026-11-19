/**
 * What the index asks of a workspace record beyond keeping it: the reads it
 * answers its port from, the writes it makes, and the subtree it moves in and
 * out of the trash. Written once over a `RecordKind`, so the index holds a
 * `LoroDoc` or an engine lease without learning which.
 *
 * Every write is a batch, because the engine commits a batch as one change and
 * the index's operations (a delete's trash row, the node's removal and the
 * folders it emptied) must stand or fall together. The legacy kind applies the
 * same steps through the helpers the engine's writers wrap, so a record written
 * by either is the same bytes.
 */
import {
  type CrdtEngine,
  createWorkspaceDocumentAtPath,
  deleteWorkspaceNodeAtPath,
  duplicateWorkspaceDocument,
  exportWorkspaceSubtree,
  forgetTrashEntry,
  importWorkspaceSubtree,
  type LeaseKindOptions,
  type LegacyRecord,
  leaseKind,
  lease as leases,
  loroDocKind,
  moveWorkspaceNodeToPath,
  pruneEmptyFolders,
  type RecordKind,
  type RecordLease,
  readPinnedDocumentIds,
  readTrashEntries,
  readWorkspaceDocuments,
  readWorkspaceFolderNames,
  readWorkspaceNodes,
  reapplyFolderNames,
  recordTrashEntry,
  resolveWorkspaceDocumentById,
  setWorkspaceDocumentName,
  setWorkspaceFolderName,
  setWorkspacePinned,
  type TrashEntry,
  type WorkspaceDocumentEntry,
  type WorkspaceNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'

/** One step of a write: the engine writer's name and the arguments both kinds take. */
type IndexWrite =
  | {
      readonly op: 'createWorkspaceDocumentAtPath'
      readonly args: Parameters<typeof createWorkspaceDocumentAtPath>[1]
    }
  | {
      readonly op: 'duplicateWorkspaceDocument'
      readonly args: Parameters<typeof duplicateWorkspaceDocument>[1]
    }
  | { readonly op: 'moveWorkspaceNodeToPath'; readonly args: { from: string; to: string } }
  | { readonly op: 'deleteWorkspaceNodeAtPath'; readonly args: { path: string } }
  | { readonly op: 'pruneEmptyFolders'; readonly args: Record<string, never> }
  | {
      readonly op: 'setWorkspaceDocumentName'
      readonly args: { documentId: string; name?: string }
    }
  | { readonly op: 'setWorkspaceFolderName'; readonly args: { path: string; name?: string } }
  | { readonly op: 'setWorkspacePinned'; readonly args: { documentId: string; pinned: boolean } }
  | { readonly op: 'recordTrashEntry'; readonly args: { entry: TrashEntry } }
  | { readonly op: 'forgetTrashEntry'; readonly args: { documentId: string } }
  | {
      readonly op: 'reapplyFolderNames'
      readonly args: { names: Array<{ path: string; name: string }> }
    }

interface IndexRecordOps<R> {
  // The reads are asynchronous because the index can wait, and a caller that
  // can wait does not tie itself to an engine in its own realm.
  documents(record: R): Promise<WorkspaceDocumentEntry[]>
  nodes(record: R): Promise<WorkspaceNode[]>
  trash(record: R): Promise<TrashEntry[]>
  folderNames(record: R): Promise<Array<{ path: string; name: string }>>
  pinned(record: R): Promise<string[]>
  entryById(record: R, documentId: string): Promise<WorkspaceDocumentEntry | null>
  /** Applies the steps in order as one change; a step that throws leaves the record as it was on a lease. */
  write(record: R, batch: readonly IndexWrite[]): void
  /** The bytes of the node at `path` with all under it, or `null` when nothing is there. */
  exportSubtree(record: R, path: string): Uint8Array | null
  /**
   * Places an exported document under `parentPath` and answers the entry it
   * became, or `null` when the bytes hold no document.
   */
  importSubtree(
    record: R,
    bytes: Uint8Array,
    parentPath: string | undefined,
  ): Promise<WorkspaceDocumentEntry | null>
}

/** A record kind the index can run over. */
export interface IndexRecordKind<R> extends RecordKind<R>, IndexRecordOps<R> {}

function applyLegacy(doc: LegacyRecord, step: IndexWrite): void {
  switch (step.op) {
    case 'createWorkspaceDocumentAtPath':
      createWorkspaceDocumentAtPath(doc, step.args)
      return
    case 'duplicateWorkspaceDocument':
      duplicateWorkspaceDocument(doc, step.args)
      return
    case 'moveWorkspaceNodeToPath':
      moveWorkspaceNodeToPath(doc, step.args.from, step.args.to)
      return
    case 'deleteWorkspaceNodeAtPath':
      deleteWorkspaceNodeAtPath(doc, step.args.path)
      return
    case 'pruneEmptyFolders':
      pruneEmptyFolders(doc)
      return
    case 'setWorkspaceDocumentName':
      setWorkspaceDocumentName(doc, step.args)
      return
    case 'setWorkspaceFolderName':
      setWorkspaceFolderName(doc, step.args)
      return
    case 'setWorkspacePinned':
      setWorkspacePinned(doc, step.args.documentId, step.args.pinned)
      return
    case 'recordTrashEntry':
      recordTrashEntry(doc, step.args.entry)
      return
    case 'forgetTrashEntry':
      forgetTrashEntry(doc, step.args.documentId)
      return
    case 'reapplyFolderNames':
      reapplyFolderNames(doc, step.args.names)
      return
  }
}

/** Records held as a `LoroDoc`. ponytail: goes with `loroDocKind`. */
export const loroIndexKind: IndexRecordKind<LegacyRecord> = {
  ...loroDocKind,
  documents: async (doc) => readWorkspaceDocuments(doc),
  nodes: async (doc) => readWorkspaceNodes(doc),
  trash: async (doc) => readTrashEntries(doc),
  folderNames: async (doc) =>
    readWorkspaceFolderNames(doc).map(({ path, name }) => ({ path, name })),
  pinned: async (doc) => readPinnedDocumentIds(doc),
  entryById: async (doc, documentId) => resolveWorkspaceDocumentById(doc, documentId),
  write(doc, batch) {
    for (const step of batch) applyLegacy(doc, step)
  },
  exportSubtree: exportWorkspaceSubtree,
  importSubtree: async (doc, bytes, parentPath) => importWorkspaceSubtree(doc, bytes, parentPath),
}

// The engine answers in the shapes the loro-adapter readers return; this
// package asserts the type and holds no schema of its own for it.
const assertedAs = <T>() => ({ parse: (value: unknown) => value as T })

const read = <T>(record: RecordLease, query: Parameters<typeof leases.read>[1]) =>
  leases.read(record, query, assertedAs<T>())

/**
 * Records held as engine leases. Writes are unjudged: the keeper judges what
 * it is pushed, as it does for a `LoroDoc` the index edits in place.
 */
export function leaseIndexKind(
  loadEngine: () => Promise<CrdtEngine>,
  options: LeaseKindOptions = {},
): IndexRecordKind<RecordLease> {
  return {
    ...leaseKind(loadEngine, options),
    documents: (record) => read<WorkspaceDocumentEntry[]>(record, { query: 'documents' }),
    nodes: (record) => read<WorkspaceNode[]>(record, { query: 'nodes' }),
    trash: (record) => read<TrashEntry[]>(record, { query: 'trash' }),
    folderNames: (record) =>
      read<Array<{ path: string; name: string }>>(record, { query: 'folderNames' }),
    pinned: (record) => read<string[]>(record, { query: 'pinned' }),
    entryById: (record, documentId) =>
      read<WorkspaceDocumentEntry | null>(record, {
        query: 'workspaceDocumentEntry',
        args: { documentId },
      }),
    write(record, batch) {
      leases.write(record, [...batch], { judge: 'none' })
    },
    exportSubtree(record, path) {
      const { bytes } = record.engine.export({ handle: record.handle, mode: 'subtree', path })
      return bytes === undefined ? null : base64ToBytes(bytes)
    },
    async importSubtree(record, bytes, parentPath) {
      const placed = record.engine.importSubtree({
        handle: record.handle,
        bytes: bytesToBase64(bytes),
        ...(parentPath === undefined ? {} : { parentPath }),
        judge: 'none',
      })
      if (placed.outcome !== 'applied' || placed.root === undefined) return null
      return read<WorkspaceDocumentEntry | null>(record, {
        query: 'workspaceDocumentEntry',
        args: { documentId: placed.root.documentId },
      })
    },
  }
}
