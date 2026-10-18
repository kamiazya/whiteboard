import {
  importWithinTextLimits,
  readWorkspaceDocuments,
  rootsNoDocumentNodeHolds,
  unreadableWorkspaceNodes,
} from '@kamiazya/whiteboard-loro-adapter'
import { DOCUMENT_NAME_MAX_LENGTH, documentPathSchema } from '@kamiazya/whiteboard-model'
import type { Frontiers, LoroDoc } from 'loro-crdt'
import { type CachedTarget, runEvictingOnEngineTrap } from '../document-io.js'
import { getLogger } from '../log.js'
import {
  DocumentNameTooLongError,
  OffGrammarPathError,
  RootNoDocumentHoldsError,
  type SyncWriteRefusalError,
  TooManyDocumentsError,
  textBreachRefusal,
  UnreadableDocumentMetaError,
  WORKSPACE_MAX_DOCUMENTS,
} from './sync-write-refusals.js'

const log = getLogger('sync-write-limit')

function refuse(target: CachedTarget, error: SyncWriteRefusalError): never {
  target.evict()
  log.warning('sync write refused', { ...target.fields, reason: error.message })
  throw error
}

/**
 * What a workspace record's tree says about its documents, as the placement
 * checks compare it. One entry per document NODE, never keyed by id: a
 * client can write a node carrying an id another node already has, and a
 * map by id would let the node tree-ordered last hide the rest — from the
 * ceiling's count and from the path and name checks alike.
 */
interface Placement {
  readonly documents: ReadonlyArray<{
    readonly documentId: string
    readonly path: string
    /** 0 for no name. */
    readonly nameLength: number
  }>
  /** The tree ids every listing skips, with their subtrees. */
  readonly unreadable: ReadonlySet<string>
}

function placementOf(doc: LoroDoc): Placement {
  return {
    documents: readWorkspaceDocuments(doc).map((entry) => ({
      documentId: entry.documentId,
      path: entry.path,
      nameLength: entry.name?.length ?? 0,
    })),
    unreadable: new Set(unreadableWorkspaceNodes(doc)),
  }
}

const placedAt = (documentId: string, path: string) => `${documentId}\n${path}`

/** The longest name each id carried, so a long name is judged against its own past. */
function longestNames(placement: Placement): ReadonlyMap<string, number> {
  const longest = new Map<string, number>()
  for (const { documentId, nameLength } of placement.documents) {
    longest.set(documentId, Math.max(nameLength, longest.get(documentId) ?? 0))
  }
  return longest
}

/**
 * The refusal an update's placement writes earn: a record it grew past
 * `WORKSPACE_MAX_DOCUMENTS`, a node it left unreadable, a document it MOVED
 * onto a path the grammar refuses, or a name it grew past the bound. What
 * was already so before the update is not its doing — and deleting
 * documents, moving one off a bad path, or shortening a long name is how it
 * gets repaired — so each is judged against the state before.
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
  const offGrammar = after.documents.filter(
    ({ path }) => !documentPathSchema.safeParse(path).success,
  )
  const longNames = after.documents.filter(
    ({ nameLength }) => nameLength > DOCUMENT_NAME_MAX_LENGTH,
  )
  const crowded = after.documents.length > WORKSPACE_MAX_DOCUMENTS
  if (!crowded && offGrammar.length === 0 && longNames.length === 0 && after.unreadable.size === 0)
    return null
  doc.checkout(before)
  const earlier = placementOf(doc)
  runEvictingOnEngineTrap(target, 'importing an update into', () => doc.attach())
  if (crowded && after.documents.length > earlier.documents.length) {
    return new TooManyDocumentsError(after.documents.length)
  }
  const unreadable = [...after.unreadable].filter((node) => !earlier.unreadable.has(node))
  if (unreadable.length > 0) return new UnreadableDocumentMetaError(unreadable)
  const earlierPlaces = new Set(earlier.documents.map((d) => placedAt(d.documentId, d.path)))
  const moved = offGrammar.filter((d) => !earlierPlaces.has(placedAt(d.documentId, d.path)))
  if (moved.length > 0) return new OffGrammarPathError(moved.map(({ path }) => path))
  const earlierNames = longestNames(earlier)
  const grown = longNames.filter((d) => d.nameLength > (earlierNames.get(d.documentId) ?? 0))
  if (grown.length > 0) return new DocumentNameTooLongError(grown.map(({ path }) => path))
  return null
}

/**
 * Imports a client's update into a CACHED document unless it breaks a text
 * bound (`SYNC_TEXT_BREACH_CODES` lists them) or, for a workspace record,
 * what the record's readers need of a node — in which case nothing of it is
 * kept, and the refusal is thrown as its `SyncWriteRefusalError`.
 *
 * What the update does to text is `importWithinTextLimits`'s judgement, the
 * one the browser keeper takes too; this adds what only the daemon's sync
 * surface owes: readable node meta, the path grammar and the name bound.
 * Those are checked only for an update that writes a workspace node's meta
 * or moves one (`placementRefusal`); a body edit pays nothing for them. A
 * standalone document's update instead answers for the roots it adds, since
 * its content is saved onto its node's own map (`rootsNoDocumentNodeHolds`).
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
  // Judged against the document as it was, so a root it already held — which
  // no save could have written onto its node — does not refuse every edit after.
  const heldBefore = new Set(options.workspaceRecord ? [] : rootsNoDocumentNodeHolds(doc))
  const trapped = { ...target, fields: { ...target.fields, updateBytes: update.byteLength } }
  const { breach, touchesNodeMeta } = runEvictingOnEngineTrap(
    trapped,
    'importing an update into',
    () => importWithinTextLimits(doc, update),
  )
  if (breach !== null) refuse(target, textBreachRefusal(breach))
  if (!options.workspaceRecord) {
    const added = rootsNoDocumentNodeHolds(doc).filter((root) => !heldBefore.has(root))
    if (added.length > 0) refuse(target, new RootNoDocumentHoldsError(added))
    return
  }
  if (!touchesNodeMeta) return
  const refusal = placementRefusal(doc, before, trapped)
  if (refusal !== null) refuse(target, refusal)
}
