import {
  importWithinTextLimits,
  readWorkspaceDocuments,
  type SyncTextBreach,
  unreadableWorkspaceNodes,
} from '@kamiazya/whiteboard-loro-adapter'
import { DOCUMENT_NAME_MAX_LENGTH, documentPathSchema } from '@kamiazya/whiteboard-model'
import type { Frontiers, LoroDoc } from 'loro-crdt'
import { type CachedTarget, runEvictingOnEngineTrap } from '../document-io.js'
import { getLogger } from '../log.js'
import {
  CommentMessageTooLargeError,
  DocumentNameTooLongError,
  LabelTooLargeError,
  MarkdownBodyTooLargeError,
  NodeTextTooLargeError,
  OffGrammarPathError,
  type SyncWriteRefusalError,
  UnreadableDocumentMetaError,
} from './sync-write-refusals.js'

const log = getLogger('sync-write-limit')

function refuse(target: CachedTarget, error: SyncWriteRefusalError): never {
  target.evict()
  log.warning('sync write refused', { ...target.fields, reason: error.message })
  throw error
}

/** The one refusal each way an update can break a text bound is answered with. */
function breachRefusal(breach: SyncTextBreach): SyncWriteRefusalError {
  switch (breach.shape) {
    case 'node-text':
      return new NodeTextTooLargeError(breach.nodeId, breach.chars)
    case 'label':
      return new LabelTooLargeError(breach.elementId, breach.chars)
    case 'comment-message':
      return new CommentMessageTooLargeError(breach.messageId, breach.chars)
    case 'run':
    case 'body':
      return new MarkdownBodyTooLargeError(breach.shape, breach.chars, breach.container)
  }
}

/** What a workspace record's tree says about its documents, as the placement checks compare it. */
interface Placement {
  /** Each listed document's path, by id. */
  readonly paths: ReadonlyMap<string, string>
  /** Each listed document's name length, by id; 0 for no name. */
  readonly names: ReadonlyMap<string, number>
  /** The tree ids every listing skips, with their subtrees. */
  readonly unreadable: ReadonlySet<string>
}

function placementOf(doc: LoroDoc): Placement {
  const entries = readWorkspaceDocuments(doc)
  return {
    paths: new Map(entries.map((entry) => [entry.documentId, entry.path])),
    names: new Map(entries.map((entry) => [entry.documentId, entry.name?.length ?? 0])),
    unreadable: new Set(unreadableWorkspaceNodes(doc)),
  }
}

/**
 * The refusal an update's placement writes earn: a node it left unreadable, a
 * document it MOVED onto a path the grammar refuses, or a name it grew past
 * the bound. What was already so before the update is not its doing — and
 * moving a document off a bad path, or shortening a long name, is how it gets
 * repaired — so each is judged against the state before.
 *
 * One walk of the tree in the usual case, where nothing is suspect. Only when
 * something is does the state go back to `before` for a second walk, which
 * costs re-applying this update: the rare case of a workspace still holding
 * data written before a bound was enforced, or a write that breaks one.
 */
function placementRefusal(
  doc: LoroDoc,
  before: Frontiers,
  target: CachedTarget,
): SyncWriteRefusalError | null {
  const after = placementOf(doc)
  const offGrammar = [...after.paths].filter(
    ([, path]) => !documentPathSchema.safeParse(path).success,
  )
  const longNames = [...after.names].filter(([, length]) => length > DOCUMENT_NAME_MAX_LENGTH)
  if (offGrammar.length === 0 && longNames.length === 0 && after.unreadable.size === 0) return null
  doc.checkout(before)
  const earlier = placementOf(doc)
  runEvictingOnEngineTrap(target, 'importing an update into', () => doc.attach())
  const unreadable = [...after.unreadable].filter((node) => !earlier.unreadable.has(node))
  if (unreadable.length > 0) return new UnreadableDocumentMetaError(unreadable)
  const moved = offGrammar.filter(([documentId, path]) => earlier.paths.get(documentId) !== path)
  if (moved.length > 0) return new OffGrammarPathError(moved.map(([, path]) => path))
  const grown = longNames.filter(
    ([documentId, length]) => length > (earlier.names.get(documentId) ?? 0),
  )
  if (grown.length > 0) {
    return new DocumentNameTooLongError(
      grown.map(([documentId]) => after.paths.get(documentId) ?? documentId),
    )
  }
  return null
}

/**
 * Imports a client's update into a CACHED document unless it breaks the
 * markdown size limit, the node-text limit or, for a workspace record, what
 * the record's readers need of a node — in which case nothing of it is kept.
 *
 * What the update does to text is `importWithinTextLimits`'s judgement, the
 * one the browser keeper takes too; this adds what only the daemon's sync
 * surface owes: readable node meta, the path grammar and the name bound.
 * Those are checked only for an update that writes a workspace node's meta
 * or moves one (`placementRefusal`); a body edit pays nothing for them.
 *
 * Every refusal drops the cached instance instead of saving, so the next
 * read rebuilds it from storage and nothing of the write survives.
 * Everything from the import to the refusal is synchronous, so no other
 * request sees the half-taken state.
 */
export function importWithinSyncLimits(
  doc: LoroDoc,
  update: Uint8Array,
  target: CachedTarget,
  options: { readonly workspaceRecord: boolean },
): void {
  const before = doc.oplogFrontiers()
  const trapped = { ...target, fields: { ...target.fields, updateBytes: update.byteLength } }
  const { breach, touchesNodeMeta } = runEvictingOnEngineTrap(
    trapped,
    'importing an update into',
    () => importWithinTextLimits(doc, update),
  )
  if (breach !== null) refuse(target, breachRefusal(breach))
  if (!(options.workspaceRecord && touchesNodeMeta)) return
  const refusal = placementRefusal(doc, before, trapped)
  if (refusal !== null) refuse(target, refusal)
}
