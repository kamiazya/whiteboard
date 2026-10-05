import {
  importWithinTextLimits,
  readWorkspaceDocuments,
  unreadableWorkspaceNodes,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  DOCUMENT_NAME_MAX_LENGTH,
  documentPathSchema,
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import type { Frontiers, LoroDoc } from 'loro-crdt'
import {
  type CachedTarget,
  DocumentEngineTrapError,
  runEvictingOnEngineTrap,
} from '../document-io.js'
import { getLogger } from '../log.js'

const log = getLogger('sync-write-limit')

/**
 * A sync write refused because of what its bytes would do to a body: insert
 * one piece longer than `MARKDOWN_MAX_CHARS`, or leave a markdown body longer
 * than that and longer than it was. Nothing of the write was kept.
 */
export class MarkdownBodyTooLargeError extends Error {
  constructor(
    public readonly shape: 'run' | 'body',
    public readonly chars: number,
  ) {
    super(
      shape === 'run'
        ? `This update inserts ${chars} characters in one piece, past the ${MARKDOWN_MAX_CHARS}-character limit for one write; split the content across documents`
        : `This update would make a document body ${chars} characters long, past the ${MARKDOWN_MAX_CHARS}-character limit for one document; split the content across documents`,
    )
    this.name = 'MarkdownBodyTooLargeError'
  }
}

/**
 * A sync write refused because it would add or grow a node's text past
 * `NODE_TEXT_MAX_CHARS` — the bound every tool write already holds, since
 * each read of the canvas lays that text out again. Nothing of the write was
 * kept; a node stored longer before the bound still takes an edit that does
 * not grow it.
 */
export class NodeTextTooLargeError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly chars: number,
  ) {
    super(
      `This update would give node ${JSON.stringify(nodeId)} ${chars} characters of text, past the ${NODE_TEXT_MAX_CHARS}-character limit for one node; split it across nodes, or put it in a markdown document and embed that`,
    )
    this.name = 'NodeTextTooLargeError'
  }
}

/**
 * A sync write refused because it would put documents at paths the
 * document-path grammar refuses — a path every listing and search of the
 * workspace then fails on. Nothing of the write was kept.
 */
export class OffGrammarPathError extends Error {
  constructor(public readonly paths: readonly string[]) {
    const quoted = paths.map((path) => JSON.stringify(path)).join(', ')
    super(
      `This update would put documents at paths this keeper cannot store: ${quoted}. A path segment may hold only ASCII letters, digits and interior hyphens`,
    )
    this.name = 'OffGrammarPathError'
  }
}

/**
 * A sync write refused because it would leave workspace nodes this keeper
 * cannot read — a kind it does not know, an empty segment, a missing id.
 * Every listing, search and read skips such a node with everything below it,
 * so the documents would vanish with no trash entry. Nothing of the write
 * was kept; a node already unreadable before the write is left as it was.
 */
export class UnreadableDocumentMetaError extends Error {
  constructor(public readonly nodes: readonly string[]) {
    super(
      `This update would leave workspace nodes this keeper cannot read (${nodes.join(', ')}), which hides the documents they hold and everything below them; a document needs a known kind, a segment and its id`,
    )
    this.name = 'UnreadableDocumentMetaError'
  }
}

/**
 * A sync write refused because it would give documents display names past
 * `DOCUMENT_NAME_MAX_LENGTH`, the bound every other name write holds. A name
 * stored longer before the bound, left or shortened, is let through.
 */
export class DocumentNameTooLongError extends Error {
  constructor(public readonly paths: readonly string[]) {
    super(
      `This update would give ${paths.map((path) => JSON.stringify(path)).join(', ')} a display name past ${DOCUMENT_NAME_MAX_LENGTH} characters, the most a name may have`,
    )
    this.name = 'DocumentNameTooLongError'
  }
}

/** A throw the sync write raises on purpose and its caller answers, not a refused import. */
export function isSyncWriteRefusal(err: unknown): boolean {
  return (
    err instanceof DocumentEngineTrapError ||
    err instanceof MarkdownBodyTooLargeError ||
    err instanceof NodeTextTooLargeError ||
    err instanceof OffGrammarPathError ||
    err instanceof UnreadableDocumentMetaError ||
    err instanceof DocumentNameTooLongError
  )
}

function refuse(target: CachedTarget, error: Error): never {
  target.evict()
  log.warning('sync write refused', { ...target.fields, reason: error.message })
  throw error
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
function placementRefusal(doc: LoroDoc, before: Frontiers, target: CachedTarget): Error | null {
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
  if (breach?.shape === 'node-text') {
    refuse(target, new NodeTextTooLargeError(breach.nodeId, breach.chars))
  }
  if (breach !== null) refuse(target, new MarkdownBodyTooLargeError(breach.shape, breach.chars))
  if (!(options.workspaceRecord && touchesNodeMeta)) return
  const refusal = placementRefusal(doc, before, trapped)
  if (refusal !== null) refuse(target, refusal)
}
