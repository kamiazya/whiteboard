import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ReservedKeyWriteError,
  RetiredCommentPlaneError,
  RetiredStoredShapeError,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  DisplayNameTakenError,
  DocumentHasDescendantsError,
  DocumentMoveIntoSelfError,
  DocumentNotFoundError,
  DocumentPathContestedError,
  DocumentPathTakenError,
  NoRoomForCopyError,
  StoredDocumentUnreadableError,
  TooManyDocumentsError,
  TooManyFoldersError,
  TooManyWorkspacesError,
  WorkspaceNotFoundError,
  WorkspaceSegmentTakenError,
} from '@kamiazya/whiteboard-ports'
import { ReferenceRewriteTooLargeError } from '@kamiazya/whiteboard-reference-graph'
import { describe, expect, it } from 'vitest'
import { DocumentEngineTrapError, SnapshotNotFoundError } from './document-io.js'
import {
  InvalidRestoreTargetPathError,
  RestoredDocumentIdMissingError,
} from './operations/restore-refusals.js'
import {
  CausalGapError,
  DocumentKindChangedError,
  DocumentNameTooLongError,
  FolderNameRefusedError,
  OffGrammarPathError,
  textBreachRefusal,
  UnreadableDocumentMetaError,
} from './operations/sync-write-refusals.js'
import {
  DocumentNameConflictError,
  WorkspaceDocumentNotFoundError,
  WorkspaceNotFoundForCallerError,
  WorkspaceSegmentUnusableError,
} from './tools/document-crud.errors.js'
import { SearchNeedsQueryOrFilterError } from './tools/document-search.js'
import { OkfParseError } from './tools/document-set.js'
import {
  DocumentKindMismatchError,
  DocumentSerializeError,
  EdgeNotFoundError,
  ElementLockedError,
  FacetWriteRejectedError,
  NodeNotFoundError,
  TooManyTagsError,
} from './tools/errors.js'
import {
  DocumentHasNoFrontmatterError,
  FacetSetNeedsPayloadError,
  NodeAndCanvasTargetError,
  NodeAndEdgeTargetError,
  NodeTargetNeedsOneDocumentError,
} from './tools/facet-set.js'
import { NamelessLinkifyTargetError } from './tools/linkify-mentions.js'
import { refuseAgainstLibrary } from './tools/tag-library.js'
import { ThreadEditError } from './tools/thread-edit-error.js'
import {
  RestoreTargetExistsError,
  SubtreeNeedsWorkspaceVersionError,
  SubtreeTakesNoTargetError,
  VersionNotFoundError,
} from './tools/version-restore.js'
import { TooManyVersionsError } from './versions/version-refusal.js'

const contract = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../contracts/api/refusals.json'), 'utf8'),
) as {
  refusals: {
    name: string
    code: string
    status: number
    example: Record<string, unknown>
    exampleText: string
  }[]
}

/**
 * Answered by something other than an error class: the route's own sentence,
 * or the daemon-client's `workspaceNotFoundRefusal`, which has a test of its
 * own beside it.
 */
const NOT_A_CLASS = [
  'InvalidBodyNotJson',
  'InvalidRequest',
  'DatabaseBusy',
  'InternalError',
  'SearchNeedsQueryOrFilterRoute',
  'WorkspaceNotFoundByHandle',
] as const

const CONTAINER = 'cid:1@2:Map' as never
const at = (path: string) => ({ path })
const textOf = (error: Error) => error.message

// The example's fields are held to the entry's params by the run below, which builds every class from them.
type Params = Record<string, any>
type Factories = Record<string, (p: Params) => Error>

const FACTORIES: Factories = {
  MarkdownRunUpdate: (p) =>
    textBreachRefusal({ shape: 'run', chars: p.chars, container: CONTAINER }),
  MarkdownBodyUpdate: (p) =>
    textBreachRefusal({ shape: 'body', chars: p.chars, container: CONTAINER }),
  MarkdownRunsUpdate: (p) =>
    textBreachRefusal({ shape: 'runs', chars: p.chars, runs: p.runs, container: CONTAINER }),
  MarkdownBodyDocument: (p) =>
    textBreachRefusal({ shape: 'body', chars: p.chars, container: CONTAINER }, at(p.path)),
  MarkdownRunDocument: (p) =>
    textBreachRefusal({ shape: 'run', chars: p.chars, container: CONTAINER }, at(p.path)),
  MarkdownRunDocumentWithBody: (p) =>
    textBreachRefusal(
      { shape: 'run', chars: p.chars, container: CONTAINER },
      { ...at(p.path), bodyChars: p.bodyChars },
    ),
  MarkdownRunsDocument: (p) =>
    textBreachRefusal(
      { shape: 'runs', chars: p.chars, runs: p.runs, container: CONTAINER },
      at(p.path),
    ),
  NodeTextTooLargeUpdate: (p) =>
    textBreachRefusal({
      shape: 'node-text',
      chars: p.chars,
      nodeId: p.nodeId,
      container: CONTAINER,
    }),
  NodeTextTooLargeDocument: (p) =>
    textBreachRefusal(
      { shape: 'node-text', chars: p.chars, nodeId: p.nodeId, container: CONTAINER },
      at(p.path),
    ),
  NodeLocationTooLargeUpdate: (p) =>
    textBreachRefusal({
      shape: 'node-location',
      chars: p.chars,
      nodeId: p.nodeId,
      container: CONTAINER,
    }),
  NodeLocationTooLargeDocument: (p) =>
    textBreachRefusal(
      { shape: 'node-location', chars: p.chars, nodeId: p.nodeId, container: CONTAINER },
      at(p.path),
    ),
  LabelTooLargeUpdate: (p) =>
    textBreachRefusal({
      shape: 'label',
      chars: p.chars,
      elementId: p.elementId,
      container: CONTAINER,
    }),
  LabelTooLargeDocument: (p) =>
    textBreachRefusal(
      { shape: 'label', chars: p.chars, elementId: p.elementId, container: CONTAINER },
      at(p.path),
    ),
  CommentMessageTooLargeUpdate: (p) =>
    textBreachRefusal({
      shape: 'comment-message',
      chars: p.chars,
      messageId: p.messageId,
      container: CONTAINER,
    }),
  CommentMessageTooLargeDocument: (p) =>
    textBreachRefusal(
      { shape: 'comment-message', chars: p.chars, messageId: p.messageId, container: CONTAINER },
      at(p.path),
    ),
  ContainerNameTooLongUpdate: (p) =>
    textBreachRefusal({ shape: 'container-name', chars: p.chars, container: CONTAINER }),
  ContainerNameTooLongDocument: (p) =>
    textBreachRefusal(
      { shape: 'container-name', chars: p.chars, container: CONTAINER },
      at(p.path),
    ),
  CommentAnchorTooLargeUpdate: (p) =>
    textBreachRefusal({
      shape: 'thread-anchor',
      count: p.count,
      threadId: p.threadId,
      container: CONTAINER,
    }),
  CommentAnchorTooLargeDocument: (p) =>
    textBreachRefusal(
      { shape: 'thread-anchor', count: p.count, threadId: p.threadId, container: CONTAINER },
      at(p.path),
    ),
  AnchorQuoteTooLongUpdate: (p) =>
    textBreachRefusal({
      shape: 'anchor-quote',
      chars: p.chars,
      elementId: p.elementId,
      container: CONTAINER,
    }),
  AnchorQuoteTooLongDocument: (p) =>
    textBreachRefusal(
      { shape: 'anchor-quote', chars: p.chars, elementId: p.elementId, container: CONTAINER },
      at(p.path),
    ),
  TooManyOpenThreadsUpdate: (p) =>
    textBreachRefusal({ shape: 'open-threads', count: p.count, container: CONTAINER }),
  TooManyOpenThreadsDocument: (p) =>
    textBreachRefusal({ shape: 'open-threads', count: p.count, container: CONTAINER }, at(p.path)),
  TooManyOpenChangesUpdate: (p) =>
    textBreachRefusal({ shape: 'open-changes', count: p.count, container: CONTAINER }),
  TooManyOpenChangesDocument: (p) =>
    textBreachRefusal({ shape: 'open-changes', count: p.count, container: CONTAINER }, at(p.path)),
  TooManyThreadMessagesUpdate: (p) =>
    textBreachRefusal({ shape: 'thread-messages', count: p.count, container: CONTAINER }),
  TooManyThreadMessagesDocument: (p) =>
    textBreachRefusal(
      { shape: 'thread-messages', count: p.count, container: CONTAINER },
      at(p.path),
    ),
  TagsCountBoardUpdate: (p) =>
    textBreachRefusal({
      shape: 'tags',
      measure: 'count',
      amount: p.amount,
      elementId: null,
      container: CONTAINER,
    }),
  TagsCountBoardDocument: (p) =>
    textBreachRefusal(
      { shape: 'tags', measure: 'count', amount: p.amount, elementId: null, container: CONTAINER },
      at(p.path),
    ),
  TagsCountElementUpdate: (p) =>
    textBreachRefusal({
      shape: 'tags',
      measure: 'count',
      amount: p.amount,
      elementId: p.elementId,
      container: CONTAINER,
    }),
  TagsCountElementDocument: (p) =>
    textBreachRefusal(
      {
        shape: 'tags',
        measure: 'count',
        amount: p.amount,
        elementId: p.elementId,
        container: CONTAINER,
      },
      at(p.path),
    ),
  TagsLengthBoardUpdate: (p) =>
    textBreachRefusal({
      shape: 'tags',
      measure: 'chars',
      amount: p.amount,
      elementId: null,
      container: CONTAINER,
    }),
  TagsLengthBoardDocument: (p) =>
    textBreachRefusal(
      { shape: 'tags', measure: 'chars', amount: p.amount, elementId: null, container: CONTAINER },
      at(p.path),
    ),
  TagsLengthElementUpdate: (p) =>
    textBreachRefusal({
      shape: 'tags',
      measure: 'chars',
      amount: p.amount,
      elementId: p.elementId,
      container: CONTAINER,
    }),
  TagsLengthElementDocument: (p) =>
    textBreachRefusal(
      {
        shape: 'tags',
        measure: 'chars',
        amount: p.amount,
        elementId: p.elementId,
        container: CONTAINER,
      },
      at(p.path),
    ),
  CanvasTooLargeNodesUpdate: (p) =>
    textBreachRefusal({
      shape: 'canvas-size',
      measure: 'nodes',
      count: p.count,
      container: CONTAINER,
    }),
  CanvasTooLargeNodesDocument: (p) =>
    textBreachRefusal(
      { shape: 'canvas-size', measure: 'nodes', count: p.count, container: CONTAINER },
      at(p.path),
    ),
  CanvasTooLargeEdgesAndLinesUpdate: (p) =>
    textBreachRefusal({
      shape: 'canvas-size',
      measure: 'edges-and-lines',
      count: p.count,
      container: CONTAINER,
    }),
  CanvasTooLargeEdgesAndLinesDocument: (p) =>
    textBreachRefusal(
      { shape: 'canvas-size', measure: 'edges-and-lines', count: p.count, container: CONTAINER },
      at(p.path),
    ),
  ContentRootKindUpdate: (p) =>
    textBreachRefusal({ shape: 'content-root', key: p.key, container: CONTAINER }),
  ContentRootKindDocument: (p) =>
    textBreachRefusal({ shape: 'content-root', key: p.key, container: CONTAINER }, at(p.path)),
  UnattachedContainerUpdate: (p) =>
    textBreachRefusal({ shape: 'unattached-container', container: p.container as never }),
  UnattachedContainerDocument: (p) =>
    textBreachRefusal(
      { shape: 'unattached-container', container: p.container as never },
      at(p.path),
    ),
  ReservedMapKeyUpdate: (p) =>
    textBreachRefusal({ shape: 'reserved-map-key', container: p.container as never }),
  ReservedMapKeyDocument: (p) =>
    textBreachRefusal({ shape: 'reserved-map-key', container: p.container as never }, at(p.path)),
  ReservedKeyWrite: (p) => new ReservedKeyWriteError(p.container),
  RetiredShapeWrittenUpdate: (p) =>
    textBreachRefusal({ shape: 'retired-shape', found: p.found, container: CONTAINER }),
  RetiredShapeWrittenDocument: (p) =>
    textBreachRefusal({ shape: 'retired-shape', found: p.found, container: CONTAINER }, at(p.path)),
  RetiredCommentPlaneWrittenUpdate: (p) =>
    textBreachRefusal({ shape: 'retired-comment-plane', rows: p.rows, container: CONTAINER }),
  RetiredCommentPlaneWrittenDocument: (p) =>
    textBreachRefusal(
      { shape: 'retired-comment-plane', rows: p.rows, container: CONTAINER },
      at(p.path),
    ),
  OffGrammarPath: (p) => new OffGrammarPathError(p.paths),
  OffGrammarPathMore: (p) =>
    new OffGrammarPathError([...p.paths, ...Array.from({ length: p.more }, (_, i) => `x${i}`)]),
  UnreadableDocumentMeta: (p) => new UnreadableDocumentMetaError(p.nodes),
  DocumentKindChangedNamedKind: (p) =>
    new DocumentKindChangedError(p.recorded as never, p.kind as never, p.documentId),
  DocumentKindChangedNamedNoKind: (p) =>
    new DocumentKindChangedError(p.recorded as never, undefined, p.documentId),
  DocumentKindChangedUnnamedKind: (p) =>
    new DocumentKindChangedError(p.recorded as never, p.kind as never),
  DocumentKindChangedUnnamedNoKind: (p) =>
    new DocumentKindChangedError(p.recorded as never, undefined),
  DocumentNameTooLong: (p) => new DocumentNameTooLongError(p.paths),
  FolderNameRefused: (p) => new FolderNameRefusedError(p.paths, p.reason),
  CausalGap: () => new CausalGapError(),
  TooManyDocuments: (p) => new TooManyDocumentsError(p.documents),
  TooManyFolders: (p) => new TooManyFoldersError(p.folders),
  TooManyWorkspaces: (p) => new TooManyWorkspacesError(p.namespace),
  TooManyVersions: (p) => new TooManyVersionsError(p.limit),
  DocumentNotFound: (p) => new WorkspaceDocumentNotFoundError(p.workspaceId, p.documentId),
  DocumentNotFoundInIndex: (p) => new DocumentNotFoundError(p.workspaceId, p.target),
  DocumentSnapshotNotFound: (p) => new SnapshotNotFoundError(p.documentId),
  DocumentEngineTrapLoading: (p) => new DocumentEngineTrapError(p.subject, 'loading', 'x'),
  DocumentEngineTrapSaving: (p) => new DocumentEngineTrapError(p.subject, 'saving', 'x'),
  DocumentEngineTrapImporting: (p) =>
    new DocumentEngineTrapError(p.subject, 'importing an update into', 'x'),
  DocumentEngineTrapRunningRecovered: (p) =>
    new DocumentEngineTrapError(p.subject, 'running', 'x', true),
  DocumentEngineTrapRunningUnrecoverable: (p) =>
    new DocumentEngineTrapError(p.subject, 'running', 'x', false),
  DocumentKindMismatch: (p) =>
    new DocumentKindMismatchError(p.documentId, p.kind as never, p.detail),
  NodeNotFound: (p) => new NodeNotFoundError(p.documentId, p.nodeId),
  EdgeNotFound: (p) => new EdgeNotFoundError(p.documentId, p.edgeId),
  FacetSetNeedsPayload: () => new FacetSetNeedsPayloadError(),
  DocumentHasNoFrontmatter: (p) => new DocumentHasNoFrontmatterError(p.documentId),
  NodeTargetNeedsOneDocument: (p) => new NodeTargetNeedsOneDocumentError(p.count),
  NodeAndEdgeTarget: () => new NodeAndEdgeTargetError(),
  NodeAndCanvasTarget: () => new NodeAndCanvasTargetError(),
  NodeLockedNothingWritten: (p) => new ElementLockedError('node', p.id),
  EdgeLockedNothingWritten: (p) => new ElementLockedError('edge', p.id),
  TooManyTagsOnElement: (p) => new TooManyTagsError(p.what, p.count),
  WorkspaceNotFoundForCallerRead: (p) => new WorkspaceNotFoundForCallerError(p.workspaceId, 'read'),
  WorkspaceNotFoundForCallerReadKnown: (p) =>
    new WorkspaceNotFoundForCallerError(p.workspaceId, 'read', p.known),
  WorkspaceNotFoundForCallerCreate: (p) =>
    new WorkspaceNotFoundForCallerError(p.workspaceId, 'create'),
  WorkspaceNotFoundForCallerCreateKnown: (p) =>
    new WorkspaceNotFoundForCallerError(p.workspaceId, 'create', p.known),
  WorkspaceNotFoundInIndex: (p) => new WorkspaceNotFoundError(p.workspaceId),
  DocumentPathTaken: (p) => new DocumentPathTakenError(p.workspaceId, p.path),
  DisplayNameTaken: (p) => new DisplayNameTakenError(p.kind as never, 'a/b', p.displayName),
  WorkspaceSegmentTaken: (p) => new WorkspaceSegmentTakenError(p.segment),
  WorkspaceSegmentTakenInNamespace: (p) => new WorkspaceSegmentTakenError(p.segment, p.namespace),
  WorkspaceSegmentUnusable: (p) => new WorkspaceSegmentUnusableError(p.handle),
  DocumentNameConflict: (p) => new DocumentNameConflictError(p.given, p.title),
  DocumentHasDescendants: (p) => new DocumentHasDescendantsError(p.path, p.detail),
  DocumentMoveIntoSelf: (p) => new DocumentMoveIntoSelfError(p.from, p.to),
  CannotPlaceCopyContested: (p) => new DocumentPathContestedError(p.workspaceId, p.path),
  CannotPlaceCopyNoRoom: (p) => new NoRoomForCopyError(p.path),
  DocumentSerializeFailed: (p) =>
    new DocumentSerializeError(p.documentId, p.format, new Error(p.cause)),
  StoredDocumentUnsupportedVersion: (p) =>
    new StoredDocumentUnreadableError('unsupported-version', p.message),
  CorruptStoredData: (p) => new StoredDocumentUnreadableError('malformed', p.message),
  RetiredCommentPlane: (p) => new RetiredCommentPlaneError(p.rows),
  RetiredStoredShape: (p) => new RetiredStoredShapeError(p.found),
  ReferenceRewriteBodyTooLarge: (p) =>
    new ReferenceRewriteTooLargeError({ shape: 'body', chars: p.chars }),
  ReferenceRewriteNodeTextTooLarge: (p) =>
    new ReferenceRewriteTooLargeError({ shape: 'node-text', chars: p.chars, nodeId: p.nodeId }),
  OkfParseFailed: (p) =>
    new OkfParseError(
      p.stage,
      p.message,
      p.detail === '' ? [] : [{ path: ['a', 'b'], message: 'nope' }],
    ),
  OkfNotYamlSafe: (p) =>
    new OkfParseError(
      p.stage,
      p.message,
      p.detail === '' ? [] : [{ path: ['a', 'b'], message: 'nope' }],
    ),
  TagNotAdmitted: (p) =>
    thrownBy(() =>
      refuseAgainstLibrary({ [p.key]: { values: { dev: {}, prod: {} } } }, [p.tag], p.what),
    ),
  TagExclusive: (p) =>
    thrownBy(() =>
      refuseAgainstLibrary(
        { [p.key]: { exclusive: true, values: { dev: {}, prod: {} } } },
        [...p.carried],
        p.what,
      ),
    ),
  FacetWriteRejected: (p) => new FacetWriteRejectedError(p.facetKey, p.reason),
  SearchNeedsQueryOrFilter: () => new SearchNeedsQueryOrFilterError(),
  NamelessLinkifyTarget: (p) => new NamelessLinkifyTargetError(p.targetDocumentId),
  VersionNotFound: (p) => new VersionNotFoundError(p.documentId, p.versionId),
  RestoreTargetExists: (p) => new RestoreTargetExistsError(p.targetPath),
  SubtreeNeedsWorkspaceVersion: (p) => new SubtreeNeedsWorkspaceVersionError(p.versionId),
  SubtreeTakesNoTarget: () => new SubtreeTakesNoTargetError(),
  InvalidRestoreTargetPath: (p) => new InvalidRestoreTargetPathError(p.targetPath),
  RestoredDocumentIdMissing: (p) => new RestoredDocumentIdMissingError(p.targetPath),
  ThreadEditOpRefused: (p) => new ThreadEditError(p.opIndex, p.op, p.detail),
}

describe('the refusal contract and the TypeScript that raises it', () => {
  it('has a class for every refusal a class raises, and for no refusal the contract lacks', () => {
    const named = contract.refusals.map((e) => e.name)
    expect(named.length).toBeGreaterThan(100)
    const factories = Object.keys(FACTORIES)
    expect([...factories, ...NOT_A_CLASS].sort()).toEqual([...named].sort())
  })

  it('says each refusal the way the contract pins it', () => {
    for (const entry of contract.refusals) {
      const make = (FACTORIES as Record<string, ((p: never) => Error) | undefined>)[entry.name]
      if (make === undefined) continue
      expect(textOf(make(entry.example as never)), entry.name).toBe(entry.exampleText)
    }
  })

  it('answers each class with the code and status the contract lists for its name', () => {
    for (const entry of contract.refusals) {
      const make = (FACTORIES as Record<string, ((p: never) => Error) | undefined>)[entry.name]
      if (make === undefined) continue
      const error = make(entry.example as never) as Error & { code?: string; status?: number }
      // These two classes carry the keeper's own reason code (`malformed`); the
      // route maps it to the refusal code the contract lists.
      if (error.code === undefined || /^(StoredDocument|CorruptStored)/.test(entry.name)) continue
      expect(error.code, entry.name).toBe(entry.code)
      if (error.status !== undefined) expect(error.status, entry.name).toBe(entry.status)
    }
  })
})

function thrownBy(run: () => void): Error {
  try {
    run()
  } catch (err) {
    return err as Error
  }
  throw new Error('nothing was thrown')
}
