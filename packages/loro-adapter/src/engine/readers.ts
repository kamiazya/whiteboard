/**
 * Every question the engine's `read` answers, by the name the contract gives it.
 *
 * A content reader answers for a document's own containers, hosted on the
 * document's LoroDoc root or, when `args.documentId` names one, on a workspace
 * tree node. Typed by the contract's `QueryName`, so a reader added to the
 * contract owes an entry here and one removed here fails to compile.
 */
import { type documentEngine, documentKindSchema } from '@kamiazya/whiteboard-model'
import type { ContainerID, LoroDoc } from 'loro-crdt'
import { z } from 'zod'
import { readAnnotations, retiredCommentRows } from '../annotations.js'
import { readCommentThreads, threadMessageCounts } from '../comment-threads.js'
import { containerPlace } from '../container-place.js'
import type { DocumentContainers } from '../containers.js'
import { contentDigestOfDocument } from '../content-digest.js'
import { readContentWithTags, readDocumentContent } from '../document-content.js'
import {
  readCoreFacets,
  readDocumentKind,
  readFacets,
  readTrustFacets,
} from '../document-envelope.js'
import { scanFileReferences } from '../file-references.js'
import { collectImageRefIds } from '../image-refs.js'
import { readEdgeLocks, readNodeLocks, readSpatialCanvasWithSkipped } from '../loro-bridge.js'
import { readMarkdownBody } from '../markdown-body.js'
import { readProposals } from '../proposals.js'
import { documentsRemovedSince } from '../removed-documents.js'
import { retiredStoredShapeIn } from '../retired-stored-shape.js'
import { countSpatialNodes } from '../spatial-node-count.js'
import { stateSize } from '../state-size.js'
import { judgeStateWithinTextLimits } from '../sync-text-limits.js'
import { readThreadMarks } from '../thread-marks.js'
import { documentsTouchedSince, organisationChangedSince } from '../touched-documents.js'
import { readWorkspaceFolderNames } from '../workspace-folder-name.js'
import { resolveIndexedWorkspaceDocument } from '../workspace-node-index.js'
import { readTrashEntries } from '../workspace-trash.js'
import {
  documentContainers,
  projectWorkspaceDocument,
  readPinnedDocumentIds,
  readWorkspaceDocuments,
  readWorkspaceMeta,
  readWorkspaceNodes,
  resolveWorkspaceDocument,
  unreadableWorkspaceNodes,
} from '../workspace-tree.js'
import { type Answer, answer, answerLater, attempt, versionOfPairs } from './answers.js'

/**
 * The arguments a read takes. The contract leaves them any-value, so the
 * engine holds them to the three it knows: the hosting node of a document inside
 * a workspace record, the kind its index row records, and the version a
 * since-reader compares against.
 */
const readArgsSchema = z
  .object({
    documentId: z.string().optional(),
    /** A `workspaceDocumentEntry` read's other way to name a document: the one that owns this path. */
    path: z.string().optional(),
    /** The container a `containerPlace` read asks about. */
    container: z.string().optional(),
    /** The kind the document's index row records, for a document that records none itself. */
    kind: documentKindSchema.optional(),
    since: z.array(z.tuple([z.string(), z.number().int()])).optional(),
  })
  .strict()
type ReadArgs = z.infer<typeof readArgsSchema>

type Reader = (doc: LoroDoc, args: ReadArgs) => unknown

function hostOf(doc: LoroDoc, args: ReadArgs): DocumentContainers {
  return args.documentId === undefined ? doc : documentContainers(doc, args.documentId)
}

const content =
  (read: (host: DocumentContainers) => unknown): Reader =>
  (doc, args) =>
    read(hostOf(doc, args))

function requiredId(args: ReadArgs): string {
  if (args.documentId === undefined) throw new TypeError('this read names a document')
  return args.documentId
}

function requiredContainer(args: ReadArgs): ContainerID {
  if (args.container === undefined) throw new TypeError('this read names a container')
  return args.container as ContainerID
}

/**
 * A reader of a whole document's state: the record's own when it names no
 * document, else the document `documentId` names, read as a document of its
 * own. The projection is what a standalone copy of the document would be, so
 * the answer is the one the document gives wherever it is kept.
 */
const wholeDocument =
  (read: (doc: LoroDoc) => unknown): Reader =>
  (doc, args) => {
    if (args.documentId === undefined) return read(doc)
    const projected = projectWorkspaceDocument(doc, args.documentId)
    if (projected === null)
      throw new RangeError(`No document "${args.documentId}" in this workspace`)
    try {
      return read(projected)
    } finally {
      projected.free()
    }
  }

const since = (args: ReadArgs) => versionOfPairs(args.since ?? [])

export const READERS: Record<documentEngine.QueryName, Reader> = {
  documentKind: content(readDocumentKind),
  documentContent: (doc, args) => readDocumentContent(hostOf(doc, args), args.kind),
  // Content and tags in one read, so one lookup of the hosting node answers both.
  documentContentWithTags: (doc, args) => readContentWithTags(hostOf(doc, args), args.kind),
  spatialCanvas: content(readSpatialCanvasWithSkipped),
  nodeLocks: content((host) => [...readNodeLocks(host)].sort()),
  edgeLocks: content((host) => [...readEdgeLocks(host)].sort()),
  spatialNodeCount: content(countSpatialNodes),
  markdownBody: content(readMarkdownBody),
  bodyDelta: content((host) => host.getText('body').toDelta()),
  coreFacets: content(readCoreFacets),
  trustFacets: content(readTrustFacets),
  facets: content(readFacets),
  annotations: content(readAnnotations),
  commentThreads: content(readCommentThreads),
  threadMessageCounts: content(threadMessageCounts),
  threadMarks: content(readThreadMarks),
  proposals: content(readProposals),
  imageRefIds: content((host) => [...collectImageRefIds(host)].sort()),
  retiredStoredShape: content(retiredStoredShapeIn),
  retiredCommentRows: content(retiredCommentRows),
  stateSize: wholeDocument(stateSize),
  contentDigest: wholeDocument(contentDigestOfDocument),
  textLimitBreach: wholeDocument(judgeStateWithinTextLimits),
  documents: (doc) => readWorkspaceDocuments(doc),
  nodes: (doc) => readWorkspaceNodes(doc),
  meta: (doc) => readWorkspaceMeta(doc),
  pinned: (doc) => readPinnedDocumentIds(doc),
  trash: (doc) => readTrashEntries(doc),
  folderNames: (doc) => readWorkspaceFolderNames(doc),
  unreadableNodes: (doc) => unreadableWorkspaceNodes(doc),
  removedSince: (doc, args) => documentsRemovedSince(doc, since(args)),
  touchedSince: (doc, args) => documentsTouchedSince(doc, since(args)),
  organisationChangedSince: (doc, args) => organisationChangedSince(doc, since(args)),
  // The one asynchronous read: it asks the keeper's trash for bytes, and the
  // engine holds none, so an evacuated entry is simply unjudged.
  fileReferences: async (doc) => {
    const scan = await scanFileReferences(doc, { trashBytes: async () => null })
    return { referenced: [...scan.referenced].sort(), unjudged: scan.unjudged }
  },
  containerPlace: (doc, args) => containerPlace(doc, requiredContainer(args)),
  workspaceDocumentEntry: (doc, args) => {
    if ((args.documentId === undefined) === (args.path === undefined)) {
      throw new TypeError('this read names a document by its id or by its path, one of them')
    }
    return args.path === undefined
      ? resolveIndexedWorkspaceDocument(doc, requiredId(args))
      : resolveWorkspaceDocument(doc, args.path)
  },
  workspaceDocumentProjection: (doc, args) => {
    const projected = projectWorkspaceDocument(doc, requiredId(args))
    return projected === null
      ? null
      : {
          value: projected.toJSON(),
          documentContent: attempt(() => readDocumentContent(projected)),
          stateSize: attempt(() => stateSize(projected)),
          contentDigest: attempt(() => contentDigestOfDocument(projected)),
        }
  },
}

/** The readers that take a document's own containers, in the order a row records them. */
export const CONTENT_QUERIES = [
  'documentKind',
  'documentContent',
  'spatialCanvas',
  'nodeLocks',
  'edgeLocks',
  'spatialNodeCount',
  'markdownBody',
  'bodyDelta',
  'coreFacets',
  'trustFacets',
  'facets',
  'annotations',
  'commentThreads',
  'threadMarks',
  'proposals',
  'imageRefIds',
  'retiredStoredShape',
] as const satisfies readonly documentEngine.QueryName[]

/** A read, answered the way the recorded oracles write an answer: `{ ok }` or `{ err: class }`. */
export function readQuery(doc: LoroDoc, query: documentEngine.Query): Promise<Answer> {
  return answerLater(async () => {
    const args = readArgsSchema.parse(query.args ?? {})
    return await READERS[query.query](doc, args)
  })
}

/**
 * The same read answered without waiting. Every reader but the file scan
 * answers from the document alone; that one asks the keeper for trash bytes, so
 * a caller that needs it awaits `readQuery`.
 */
export function readQueryNow(doc: LoroDoc, query: documentEngine.Query): Answer {
  if (query.query === 'fileReferences') {
    throw new TypeError(
      'fileReferences asks the keeper, so it answers through read and not readNow',
    )
  }
  return answer(() => READERS[query.query](doc, readArgsSchema.parse(query.args ?? {})))
}
