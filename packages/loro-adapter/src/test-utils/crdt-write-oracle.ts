/**
 * The writes a recorded CRDT write row replays, by name and JSON arguments.
 *
 * The recorder (`scripts/record-crdt-write-oracle.ts`) and the replay
 * (`oracle/crdt-write-recorded-oracle.test.ts`) both apply a row through
 * `applyWriter`, so a writer's arguments stay plain JSON and the Rust crate can
 * be handed the same `{ op, args }`. A content writer takes `documentId` when
 * the document is hosted on a workspace tree node and omits it for a document
 * that is the root of its own LoroDoc.
 *
 * A writer's refusal is part of its answer and is recorded as its class; the
 * Rust port words a message differently.
 */
import type {
  CanvasEdge,
  CommentMessage,
  CommentThread,
  CommentThreadStatus,
  DocumentKind,
  ExtensionFacets,
  PinDrop,
  Proposal,
  ProposedChangeStatus,
  SpatialCanvas,
  SpatialNode,
  StoredCoreFacets,
  TrustFacets,
} from '@kamiazya/whiteboard-model'
import { LoroDoc, type TreeID } from 'loro-crdt'
import {
  moveCommentThread,
  setCommentThreadStatus,
  writeCommentThread,
  writeThreadMessage,
} from '../comment-threads.js'
import type { DocumentContainers } from '../containers.js'
import { withDocumentBatch } from '../document-batch.js'
import {
  writeCoreFacets,
  writeDocumentKind,
  writeFacets,
  writeTrustFacets,
} from '../document-envelope.js'
import {
  reconcileCoreFacets,
  reconcileFacets,
  writeCanvasFacetsField,
} from '../document-envelope-reconcile.js'
import {
  deleteSpatialEdge,
  deleteSpatialNode,
  reconcileSpatialCanvas,
  setEdgeLock,
  setNodeLock,
  withSpatialBatch,
  writeSpatialCanvas,
  writeSpatialEdge,
  writeSpatialNode,
} from '../loro-bridge.js'
import { writeMarkdownBody } from '../markdown-body.js'
import { minimalChange } from '../minimal-change.js'
import {
  seedNameFromTitle,
  seedNamesFromTitles,
  writeDocumentContentAndName,
} from '../name-from-title.js'
import { setProposedChangeStatus, writeProposal } from '../proposals.js'
import { markThreadPassages } from '../thread-marks.js'
import { documentsTouchedSince, stampEditedDocuments } from '../touched-documents.js'
import { duplicateWorkspaceDocument } from '../workspace-duplicate.js'
import { setWorkspaceFolderName } from '../workspace-folder-name.js'
import { recordTrashEntry, type TrashEntry } from '../workspace-trash.js'
import {
  createWorkspaceDocument,
  createWorkspaceDocumentAtPath,
  deleteWorkspaceDocument,
  deleteWorkspaceNode,
  deleteWorkspaceNodeAtPath,
  documentContainers,
  ensureFolderPath,
  moveWorkspaceDocument,
  moveWorkspaceNodeToPath,
  pruneEmptyFolders,
  reconcileDocContent,
  setWorkspaceDocumentName,
  setWorkspaceLastCompactedAt,
  setWorkspacePinned,
  updateWorkspaceDocumentMeta,
  type WorkspaceDocumentMetaPatch,
  writeWorkspaceDocumentContent,
} from '../workspace-tree.js'
import { versionOfPairs } from './crdt-read-oracle.js'

/** The clock every recorded write ran under; a replay pins `Date.now` to it. */
export const RECORDED_NOW = 1_700_000_000_000

interface HostArgs {
  /** Absent for a document that is the root of its own LoroDoc. */
  documentId?: string
}

const bytesOf = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'))
const docOf = (b64: string): LoroDoc => {
  const doc = new LoroDoc()
  doc.import(bytesOf(b64))
  return doc
}

type Writer = (doc: LoroDoc, args: unknown) => unknown

/** The cast is the JSON boundary: a row's arguments are whatever the recorder wrote. */
function content<A>(write: (host: DocumentContainers, args: A, doc: LoroDoc) => unknown): Writer {
  return (doc, raw) => {
    const args = raw as A & HostArgs
    const host = args.documentId === undefined ? doc : documentContainers(doc, args.documentId)
    return write(host, args, doc)
  }
}

function workspace<A>(write: (doc: LoroDoc, args: A) => unknown): Writer {
  return (doc, raw) => write(doc, raw as A)
}

export const WRITERS = {
  // ---- spatial canvas ----
  writeSpatialCanvas: content<{ canvas: SpatialCanvas }>((h, a) => writeSpatialCanvas(h, a.canvas)),
  writeSpatialNode: content<{ node: SpatialNode }>((h, a) => writeSpatialNode(h, a.node)),
  writeSpatialEdge: content<{ edge: CanvasEdge }>((h, a) => writeSpatialEdge(h, a.edge)),
  deleteSpatialNode: content<{ id: string }>((h, a) => deleteSpatialNode(h, a.id)),
  deleteSpatialEdge: content<{ id: string }>((h, a) => deleteSpatialEdge(h, a.id)),
  reconcileSpatialCanvas: content<{ prev: SpatialCanvas; next: SpatialCanvas }>((h, a) =>
    reconcileSpatialCanvas(h, a.prev, a.next),
  ),
  setNodeLock: content<{ id: string; locked: boolean }>((h, a) => setNodeLock(h, a.id, a.locked)),
  setEdgeLock: content<{ id: string; locked: boolean }>((h, a) => setEdgeLock(h, a.id, a.locked)),
  withSpatialBatch: content<{
    steps: Array<
      | { op: 'writeNode'; node: SpatialNode }
      | { op: 'writeEdge'; edge: CanvasEdge }
      | { op: 'deleteNode'; id: string }
      | { op: 'deleteEdge'; id: string }
    >
  }>((h, a) =>
    withSpatialBatch(h, (writer) => {
      for (const step of a.steps) {
        if (step.op === 'writeNode') writer.writeNode(step.node)
        else if (step.op === 'writeEdge') writer.writeEdge(step.edge)
        else if (step.op === 'deleteNode') writer.deleteNode(step.id)
        else writer.deleteEdge(step.id)
      }
    }),
  ),
  // ---- markdown body, envelope, kind ----
  writeMarkdownBody: content<{ body: string }>((h, a) => writeMarkdownBody(h, a.body)),
  writeDocumentKind: content<{ kind: DocumentKind }>((h, a) => writeDocumentKind(h, a.kind)),
  writeFacets: content<{ facets: ExtensionFacets }>((h, a) => writeFacets(h, a.facets)),
  writeCoreFacets: content<{ core: StoredCoreFacets }>((h, a) => writeCoreFacets(h, a.core)),
  writeTrustFacets: content<{ trust: TrustFacets }>((h, a) => writeTrustFacets(h, a.trust)),
  reconcileFacets: content<{ prev: ExtensionFacets; next: ExtensionFacets }>((h, a) =>
    reconcileFacets(h, a.prev, a.next),
  ),
  reconcileCoreFacets: content<{ prev?: StoredCoreFacets; next: StoredCoreFacets }>((h, a) =>
    reconcileCoreFacets(h, a.prev, a.next),
  ),
  writeCanvasFacetsField: content<{ next?: ExtensionFacets }>((h, a) =>
    writeCanvasFacetsField(h, a.next),
  ),
  // ---- the annotation layer and proposals ----
  writeCommentThread: content<{ thread: CommentThread }>((h, a) => writeCommentThread(h, a.thread)),
  writeThreadMessage: content<{ threadId: string; message: CommentMessage }>((h, a) =>
    writeThreadMessage(h, a.threadId, a.message),
  ),
  setCommentThreadStatus: content<{ threadId: string; status: CommentThreadStatus }>((h, a) =>
    setCommentThreadStatus(h, a.threadId, a.status),
  ),
  moveCommentThread: content<{ threadId: string; drop: PinDrop }>((h, a) =>
    moveCommentThread(h, a.threadId, a.drop),
  ),
  markThreadPassages: content<{ passages: Array<[string, { start: number; end: number }]> }>(
    (h, a, doc) => markThreadPassages(doc, h, new Map(a.passages)),
  ),
  writeProposal: content<{ proposal: Proposal }>((h, a) => writeProposal(h, a.proposal)),
  setProposedChangeStatus: content<{
    proposalId: string
    changeId: string
    status: ProposedChangeStatus
  }>((h, a) => setProposedChangeStatus(h, a.proposalId, a.changeId, a.status)),
  withDocumentBatch: content<{
    steps: Array<
      | { op: 'writeMarkdownBody'; body: string }
      | { op: 'reconcileSpatialCanvas'; prev: SpatialCanvas; next: SpatialCanvas }
      | { op: 'setProposedChangeStatus'; proposalId: string; changeId: string; status: string }
    >
  }>((h, a) =>
    withDocumentBatch(h, (writer) => {
      for (const step of a.steps) {
        if (step.op === 'writeMarkdownBody') writer.writeMarkdownBody(step.body)
        else if (step.op === 'reconcileSpatialCanvas') {
          writer.reconcileSpatialCanvas(step.prev, step.next)
        } else {
          writer.setProposedChangeStatus(
            step.proposalId,
            step.changeId,
            step.status as ProposedChangeStatus,
          )
        }
      }
    }),
  ),
  // ---- whole-content writes between LoroDocs ----
  reconcileDocContent: workspace<{ past: string }>((doc, a) =>
    reconcileDocContent(doc, docOf(a.past)),
  ),
  writeWorkspaceDocumentContent: workspace<{
    documentId: string
    source: string
    updatedAt?: number
  }>((doc, a) =>
    writeWorkspaceDocumentContent(
      doc,
      a.documentId,
      docOf(a.source),
      a.updatedAt === undefined ? {} : { updatedAt: a.updatedAt },
    ),
  ),
  writeDocumentContentAndName: workspace<{ documentId: string; source: string }>((doc, a) =>
    writeDocumentContentAndName(doc, a.documentId, docOf(a.source)),
  ),
  seedNameFromTitle: workspace<{ documentId: string }>((doc, a) =>
    seedNameFromTitle(doc, a.documentId),
  ),
  seedNamesFromTitles: workspace<{ since: Array<[string, number]> }>((doc, a) =>
    seedNamesFromTitles(doc, documentsTouchedSince(doc, versionOfPairs(a.since))),
  ),
  stampEditedDocuments: workspace<{ since: Array<[string, number]>; at: number }>((doc, a) =>
    stampEditedDocuments(doc, documentsTouchedSince(doc, versionOfPairs(a.since)), a.at),
  ),
  // ---- the workspace tree, its planes and its trash ----
  createWorkspaceDocumentAtPath: workspace<Parameters<typeof createWorkspaceDocumentAtPath>[1]>(
    (doc, a) => createWorkspaceDocumentAtPath(doc, a),
  ),
  createWorkspaceDocument: workspace<Parameters<typeof createWorkspaceDocument>[1]>((doc, a) =>
    createWorkspaceDocument(doc, a),
  ),
  ensureFolderPath: workspace<{ segments: string[] }>((doc, a) =>
    ensureFolderPath(doc, a.segments),
  ),
  moveWorkspaceDocument: workspace<{ documentId: string; parentId?: string }>((doc, a) =>
    moveWorkspaceDocument(doc, a),
  ),
  moveWorkspaceNodeToPath: workspace<{ from: string; to: string }>((doc, a) =>
    moveWorkspaceNodeToPath(doc, a.from, a.to),
  ),
  setWorkspaceDocumentName: workspace<{ documentId: string; name?: string }>((doc, a) =>
    setWorkspaceDocumentName(doc, a),
  ),
  setWorkspaceFolderName: workspace<{ path: string; name?: string }>((doc, a) =>
    setWorkspaceFolderName(doc, a),
  ),
  deleteWorkspaceDocument: workspace<{ documentId: string }>((doc, a) =>
    deleteWorkspaceDocument(doc, a),
  ),
  deleteWorkspaceNode: workspace<{ id: string }>((doc, a) =>
    deleteWorkspaceNode(doc, a.id as TreeID),
  ),
  deleteWorkspaceNodeAtPath: workspace<{ path: string }>((doc, a) =>
    deleteWorkspaceNodeAtPath(doc, a.path),
  ),
  setWorkspaceLastCompactedAt: workspace<{ at: number }>((doc, a) =>
    setWorkspaceLastCompactedAt(doc, a.at),
  ),
  setWorkspacePinned: workspace<{ documentId: string; pinned: boolean }>((doc, a) =>
    setWorkspacePinned(doc, a.documentId, a.pinned),
  ),
  updateWorkspaceDocumentMeta: workspace<{ documentId: string; patch: WorkspaceDocumentMetaPatch }>(
    (doc, a) => updateWorkspaceDocumentMeta(doc, a.documentId, a.patch),
  ),
  pruneEmptyFolders: workspace<Record<string, never>>((doc) => pruneEmptyFolders(doc)),
  recordTrashEntry: workspace<{ entry: TrashEntry }>((doc, a) => recordTrashEntry(doc, a.entry)),
  duplicateWorkspaceDocument: workspace<Parameters<typeof duplicateWorkspaceDocument>[1]>(
    (doc, a) => duplicateWorkspaceDocument(doc, a),
  ),
  // ---- pure ----
  minimalChange: workspace<{ current: string; next: string }>((_doc, a) =>
    minimalChange(a.current, a.next),
  ),
} satisfies Record<string, Writer>

export type WriterName = keyof typeof WRITERS

export function applyWriter(doc: LoroDoc, op: string, args: unknown): unknown {
  const writer = (WRITERS as Record<string, Writer | undefined>)[op]
  if (writer === undefined) throw new Error(`no writer named ${op}`)
  return writer(doc, args)
}
