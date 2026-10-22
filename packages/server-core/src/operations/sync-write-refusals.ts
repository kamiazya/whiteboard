// The refusals a sync write raises on purpose, and the one answer each gets.
// Every surface that runs a sync write — a document's update, the workspace
// document's update and promote — answers them through `syncWriteAnswer`, so
// a refusal added here reaches each surface with the same code and status.
import { SYNC_TEXT_BREACH_CODES, type SyncTextBreach } from '@kamiazya/whiteboard-loro-adapter'
import {
  ANCHOR_NODES_LIMIT_PHRASE,
  CANVAS_EDGES_AND_LINES_LIMIT_PHRASE,
  CANVAS_NODES_LIMIT_PHRASE,
  COMMENT_MESSAGE_LIMIT_PHRASE,
  CONTAINER_NAME_LIMIT_PHRASE,
  DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_PATH_MAX_LENGTH,
  type DocumentKind,
  LABEL_LIMIT_PHRASE,
  MARKDOWN_LIMIT_PHRASE,
  MARKDOWN_MAX_CHARS,
  NODE_LOCATION_LIMIT_PHRASE,
  NODE_TEXT_LIMIT_PHRASE,
  OPEN_CHANGES_LIMIT_PHRASE,
  OPEN_THREADS_LIMIT_PHRASE,
  type SyncWriteRefusalCode,
  TAG_COUNT_LIMIT_PHRASE,
  TAG_LENGTH_LIMIT_PHRASE,
  TEXT_ANCHOR_QUOTE_LIMIT_PHRASE,
} from '@kamiazya/whiteboard-model'
import { SyncWriteRefusalError } from '@kamiazya/whiteboard-ports'
import { DOCUMENT_ENGINE_TRAP_CODE, DocumentEngineTrapError } from '../document-io.js'

export {
  SyncWriteRefusalError,
  TooManyDocumentsError,
  TooManyFoldersError,
  WORKSPACE_MAX_DOCUMENTS,
  WORKSPACE_MAX_FOLDERS,
} from '@kamiazya/whiteboard-ports'

/** The document a refused text belongs to, once the caller could tell. */
export interface RefusedIn {
  readonly path: string
  /**
   * For a refused run or body, the body's length today — which for a run
   * found only in the history is short.
   */
  readonly bodyChars?: number
}

type BreachOf<S extends SyncTextBreach['shape']> = Extract<SyncTextBreach, { shape: S }>

/**
 * A text refusal in the words that fit who is told: what an update would do,
 * or — once the caller resolved the document — what that document holds,
 * which is what a person fixing a promoted record looks for.
 */
function valueRefusalMessage(
  at: RefusedIn | undefined,
  would: string,
  holds: string,
  limit: string,
): string {
  const what =
    at === undefined
      ? `This update would ${would}`
      : `The document at ${JSON.stringify(at.path)} ${holds}`
  return `${what}, past ${limit}`
}

function bodyRefusalMessage(breach: BreachOf<'run' | 'runs' | 'body'>, at?: RefusedIn): string {
  if (breach.shape === 'runs') return runsRefusalMessage(breach, at)
  const { shape, chars } = breach
  if (at === undefined) {
    return shape === 'run'
      ? `This update inserts ${chars} characters in one piece, past ${MARKDOWN_LIMIT_PHRASE}`
      : `This update would make a document body ${chars} characters long, past ${MARKDOWN_LIMIT_PHRASE}`
  }
  const where = JSON.stringify(at.path)
  const now =
    at.bodyChars === undefined ? '' : `, though its body is ${at.bodyChars} characters now`
  return shape === 'run'
    ? `The document at ${where} holds in its history one insert of ${chars} characters, past the ${MARKDOWN_MAX_CHARS}-character limit for one write${now}. Merging that history into a workspace that already holds documents replays it; a workspace with no documents yet takes the record whole`
    : `The document at ${where} has a body of ${chars} characters, past ${MARKDOWN_LIMIT_PHRASE}`
}

function runsRefusalMessage({ chars, runs }: BreachOf<'runs'>, at?: RefusedIn): string {
  const pieces = `${runs} separate inserts of ${chars} characters in all`
  const cost = `which together cost more to apply than one insert at the ${MARKDOWN_MAX_CHARS}-character limit for one write`
  if (at === undefined) return `This update makes ${pieces}, ${cost}`
  return `The document at ${JSON.stringify(at.path)} holds in its history ${pieces}, ${cost}. Merging that history into a workspace that already holds documents replays it; a workspace with no documents yet takes the record whole`
}

/**
 * A sync write refused for what its bytes would do to text, past one of the
 * bounds `SYNC_TEXT_BREACH_CODES` answers. Nothing of the write was kept;
 * text stored longer before its bound still takes an edit that does not grow
 * it.
 *
 * `breach` says which bound and where — its `container`, for a caller that
 * can resolve it to a document; `at` is that document, once resolved. The
 * refusal is rebuilt naming it through `textBreachRefusal`, the one place a
 * breach becomes a refusal.
 */
export abstract class TextBreachRefusalError extends SyncWriteRefusalError {
  abstract readonly breach: SyncTextBreach
  abstract readonly at?: RefusedIn
  // A bound on how much is 413; one on what an update leaves standing is not.
  readonly status: 400 | 409 | 413 = 413
}

/**
 * A run longer than `MARKDOWN_MAX_CHARS` inserted in one piece, separate runs
 * that together cost more to apply than one that long, or a markdown body
 * left longer than that and longer than it was.
 */
class MarkdownBodyTooLargeError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES.body

  constructor(
    readonly breach: BreachOf<'run' | 'runs' | 'body'>,
    readonly at?: RefusedIn,
  ) {
    super(bodyRefusalMessage(breach, at))
    this.name = 'MarkdownBodyTooLargeError'
  }
}

/**
 * A node's text added or grown past `NODE_TEXT_MAX_CHARS` — the bound every
 * tool write already holds, since each read of the canvas lays that text out
 * again.
 */
class NodeTextTooLargeError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['node-text']

  constructor(
    readonly breach: BreachOf<'node-text'>,
    readonly at?: RefusedIn,
  ) {
    const node = `node ${JSON.stringify(breach.nodeId)}`
    super(
      valueRefusalMessage(
        at,
        `give ${node} ${breach.chars} characters of text`,
        `has ${node} with ${breach.chars} characters of text`,
        NODE_TEXT_LIMIT_PHRASE,
      ),
    )
    this.name = 'NodeTextTooLargeError'
  }
}

/**
 * A link's URL, a file's path or subpath or a group's background added or
 * grown past `NODE_LOCATION_MAX_CHARS` — the bound every tool write holds,
 * since each render of the board lays a location out again as the node's
 * label, and every reader of image references follows a background.
 */
class NodeLocationTooLargeError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['node-location']

  constructor(
    readonly breach: BreachOf<'node-location'>,
    readonly at?: RefusedIn,
  ) {
    const location = `node ${JSON.stringify(breach.nodeId)} a location of ${breach.chars} characters`
    super(
      valueRefusalMessage(at, `give ${location}`, `gives ${location}`, NODE_LOCATION_LIMIT_PHRASE),
    )
    this.name = 'NodeLocationTooLargeError'
  }
}

/**
 * An edge's, a line's or a group's label added or grown past
 * `LABEL_MAX_CHARS` — the bound every tool write holds, since each render of
 * the board lays the label out again.
 */
class LabelTooLargeError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES.label

  constructor(
    readonly breach: BreachOf<'label'>,
    readonly at?: RefusedIn,
  ) {
    const label = `${JSON.stringify(breach.elementId)} a label of ${breach.chars} characters`
    super(valueRefusalMessage(at, `give ${label}`, `gives ${label}`, LABEL_LIMIT_PHRASE))
    this.name = 'LabelTooLargeError'
  }
}

/**
 * A comment message added or grown past `COMMENT_MESSAGE_MAX_CHARS` — the
 * bound every tool write holds, since each render of the board and the rail
 * lays the message out again.
 */
class CommentMessageTooLargeError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['comment-message']

  constructor(
    readonly breach: BreachOf<'comment-message'>,
    readonly at?: RefusedIn,
  ) {
    const message = `comment message ${JSON.stringify(breach.messageId)} ${breach.chars} characters long`
    super(
      valueRefusalMessage(at, `make ${message}`, `has ${message}`, COMMENT_MESSAGE_LIMIT_PHRASE),
    )
    this.name = 'CommentMessageTooLargeError'
  }
}

/**
 * A node's, edge's or board's tags grown past `TAGS_PER_ELEMENT_MAX` in
 * number, or given a tag past `TAG_MAX_CHARS` — the bounds every tool write
 * holds, since each layout of the board scores every tag it carries.
 */
class TagsTooLargeError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES.tags

  constructor(
    readonly breach: BreachOf<'tags'>,
    readonly at?: RefusedIn,
  ) {
    const carrier =
      breach.elementId === null ? 'the board' : `element ${JSON.stringify(breach.elementId)}`
    const what =
      breach.measure === 'count'
        ? `${carrier} ${breach.amount} tags`
        : `${carrier} a tag of ${breach.amount} characters`
    const limit = breach.measure === 'count' ? TAG_COUNT_LIMIT_PHRASE : TAG_LENGTH_LIMIT_PHRASE
    super(valueRefusalMessage(at, `give ${what}`, `gives ${what}`, limit))
    this.name = 'TagsTooLargeError'
  }
}

/**
 * A container brought into the record under a name past
 * `CONTAINER_NAME_MAX_CHARS` — a comment thread or a proposal opened under an
 * id that long, or a root no writer opens. Kept, a long enough name leaves a
 * record no keeper can load, so it is refused however it arrives. The message
 * gives the name's length and never the name: it may be tens of thousands of
 * characters.
 */
class ContainerNameTooLongError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['container-name']

  constructor(
    readonly breach: BreachOf<'container-name'>,
    readonly at?: RefusedIn,
  ) {
    const named = `a container named with ${breach.chars} characters`
    super(
      valueRefusalMessage(at, `bring in ${named}`, `holds ${named}`, CONTAINER_NAME_LIMIT_PHRASE),
    )
    this.name = 'ContainerNameTooLongError'
  }
}

/**
 * A board grown past `CANVAS_MAX_NODES` nodes or `CANVAS_MAX_EDGES_AND_LINES`
 * edges and lines together —
 * the bounds every tool write holds, since each render, export and tidy lays
 * the whole board out again. A board stored past one still takes an edit that
 * does not grow it.
 */
class CanvasTooLargeError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['canvas-size']

  constructor(
    readonly breach: BreachOf<'canvas-size'>,
    readonly at?: RefusedIn,
  ) {
    const board = `a canvas of ${breach.count} ${breach.measure === 'nodes' ? 'nodes' : 'edges and lines'}`
    super(
      valueRefusalMessage(
        at,
        `leave ${board}`,
        `is ${board}`,
        breach.measure === 'nodes'
          ? CANVAS_NODES_LIMIT_PHRASE
          : CANVAS_EDGES_AND_LINES_LIMIT_PHRASE,
      ),
    )
    this.name = 'CanvasTooLargeError'
  }
}

/**
 * A comment thread whose node-set anchor names more nodes than
 * `CANVAS_MAX_NODES` — every layout looks each one up, resolved threads
 * included. An anchor stored past it still takes an edit that does not grow it.
 */
class CommentAnchorTooLargeError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['thread-anchor']

  constructor(
    readonly breach: BreachOf<'thread-anchor'>,
    readonly at?: RefusedIn,
  ) {
    const thread = `comment thread ${JSON.stringify(breach.threadId)} anchored to ${breach.count} nodes`
    super(valueRefusalMessage(at, `leave ${thread}`, `holds ${thread}`, ANCHOR_NODES_LIMIT_PHRASE))
    this.name = 'CommentAnchorTooLargeError'
  }
}

/**
 * A thread or a proposed passage anchored by a quote longer than
 * `TEXT_ANCHOR_QUOTE_MAX_CHARS` — every reader of the body re-finds each
 * passage by its quote after each edit. One stored past it still takes an
 * edit that does not grow it.
 */
class AnchorQuoteTooLongError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['anchor-quote']

  constructor(
    readonly breach: BreachOf<'anchor-quote'>,
    readonly at?: RefusedIn,
  ) {
    const anchor = `${JSON.stringify(breach.elementId)} an anchor quoting ${breach.chars} characters`
    super(
      valueRefusalMessage(at, `give ${anchor}`, `gives ${anchor}`, TEXT_ANCHOR_QUOTE_LIMIT_PHRASE),
    )
    this.name = 'AnchorQuoteTooLongError'
  }
}

function openAnnotationsMessage(at: RefusedIn | undefined, what: string, limit: string): string {
  return valueRefusalMessage(at, `leave ${what} on a document`, `holds ${what}`, limit)
}

/**
 * A document left holding more open comment threads than
 * `DOCUMENT_MAX_OPEN_THREADS` — the overlay each render lays out again. A
 * document stored past it still takes an edit that opens nothing.
 */
class TooManyOpenThreadsError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['open-threads']

  constructor(
    readonly breach: BreachOf<'open-threads'>,
    readonly at?: RefusedIn,
  ) {
    super(
      openAnnotationsMessage(at, `${breach.count} open comment threads`, OPEN_THREADS_LIMIT_PHRASE),
    )
    this.name = 'TooManyOpenThreadsError'
  }
}

/** The same for open proposed changes, past `DOCUMENT_MAX_OPEN_CHANGES`. */
class TooManyOpenChangesError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['open-changes']

  constructor(
    readonly breach: BreachOf<'open-changes'>,
    readonly at?: RefusedIn,
  ) {
    super(
      openAnnotationsMessage(
        at,
        `${breach.count} open proposed changes`,
        OPEN_CHANGES_LIMIT_PHRASE,
      ),
    )
    this.name = 'TooManyOpenChangesError'
  }
}

/**
 * A document node's content key left holding a scalar, another kind of
 * container, or nothing — what every reader and writer of the document opens
 * as the container the bridge declares. The same answer the per-document
 * route gives a root a node cannot hold (`RootNoDocumentHoldsError`).
 */
class ContentRootKindError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['content-root']
  override readonly status = 400

  constructor(
    readonly breach: BreachOf<'content-root'>,
    readonly at?: RefusedIn,
  ) {
    const what =
      at === undefined
        ? 'This update would leave a document'
        : `The document at ${JSON.stringify(at.path)} is`
    super(
      `${what} holding something other than its own content container at ${JSON.stringify(breach.key)}, which leaves that document unreadable`,
    )
    this.name = 'ContentRootKindError'
  }
}

/**
 * A write into a container whose creating change the write does not build
 * on. Loro takes it in with no parent, where no bound can find it, and a
 * later attach carries all of it into a document on every replica that
 * replays the history; 409 like any change sent before what it builds on.
 */
class UnattachedContainerError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES['unattached-container']
  override readonly status = 409

  constructor(
    readonly breach: BreachOf<'unattached-container'>,
    readonly at?: RefusedIn,
  ) {
    const what =
      at === undefined
        ? 'This update writes'
        : `The document at ${JSON.stringify(at.path)} holds in its history writes`
    super(
      `${what} into a container (${breach.container}) created by a change they do not build on, so nothing of it was kept. Send them built on the change that creates the container`,
    )
    this.name = 'UnattachedContainerError'
  }
}

/** The one refusal each way a write can break a text bound is answered with, naming `at` once known. */
export function textBreachRefusal(breach: SyncTextBreach, at?: RefusedIn): TextBreachRefusalError {
  switch (breach.shape) {
    case 'node-text':
      return new NodeTextTooLargeError(breach, at)
    case 'node-location':
      return new NodeLocationTooLargeError(breach, at)
    case 'label':
      return new LabelTooLargeError(breach, at)
    case 'comment-message':
      return new CommentMessageTooLargeError(breach, at)
    case 'tags':
      return new TagsTooLargeError(breach, at)
    case 'container-name':
      return new ContainerNameTooLongError(breach, at)
    case 'canvas-size':
      return new CanvasTooLargeError(breach, at)
    case 'thread-anchor':
      return new CommentAnchorTooLargeError(breach, at)
    case 'anchor-quote':
      return new AnchorQuoteTooLongError(breach, at)
    case 'open-threads':
      return new TooManyOpenThreadsError(breach, at)
    case 'open-changes':
      return new TooManyOpenChangesError(breach, at)
    case 'content-root':
      return new ContentRootKindError(breach, at)
    case 'unattached-container':
      return new UnattachedContainerError(breach, at)
    case 'run':
    case 'runs':
    case 'body':
      return new MarkdownBodyTooLargeError(breach, at)
  }
}

/** How many refused paths a refusal names, and how much of each. */
const REFUSED_PATHS_NAMED = 3
const REFUSED_PATH_SHOWN_CHARS = 120

function shortened(path: string): string {
  return path.length <= REFUSED_PATH_SHOWN_CHARS
    ? path
    : `${path.slice(0, REFUSED_PATH_SHOWN_CHARS)}… (${path.length} characters)`
}

/**
 * A sync write refused because it would put documents or folders at paths
 * `documentPathSchema` refuses — off the segment grammar, or past
 * `DOCUMENT_PATH_MAX_LENGTH` — a path every listing and search of the
 * workspace then fails on, and, for a folder, the bound that keeps the tree
 * from growing deeper than a path can name. Nothing of the write was kept.
 * The message names both rules, since a path can break either.
 */
export class OffGrammarPathError extends SyncWriteRefusalError {
  readonly code = 'invalid_path'
  readonly status = 400

  constructor(public readonly paths: readonly string[]) {
    // A chain of folders past the bound refuses every path below the bound,
    // each longer than the last, so only the first few are named, and short.
    const named = paths.slice(0, REFUSED_PATHS_NAMED).map((path) => JSON.stringify(shortened(path)))
    const more = paths.length - named.length
    const quoted = more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ')
    super(
      `This update would put documents or folders at paths this keeper cannot store: ${quoted}. A path may be at most ${DOCUMENT_PATH_MAX_LENGTH} characters, and each segment may hold only ASCII letters, digits and interior hyphens`,
    )
    this.name = 'OffGrammarPathError'
  }
}

/**
 * A sync write refused because it would leave workspace nodes this keeper
 * cannot read — a kind it does not know, an empty segment, a missing id, a
 * timestamp that is not a number, or a key a folder does not carry.
 * Every listing, search and read skips such a node with everything below it,
 * so the documents would vanish with no trash entry. Nothing of the write
 * was kept; a node already unreadable before the write is left as it was.
 */
export class UnreadableDocumentMetaError extends SyncWriteRefusalError {
  readonly code = 'unreadable_document_meta'
  readonly status = 400

  constructor(public readonly nodes: readonly string[]) {
    super(
      `This update would leave workspace nodes this keeper cannot read (${nodes.join(', ')}), which hides the documents they hold and everything below them; a document needs a known kind, a segment, its id and whole-number timestamps, and a folder carries only its segment`,
    )
    this.name = 'UnreadableDocumentMetaError'
  }
}

/**
 * A document's sync write refused because it adds roots no workspace node can
 * take as content: named after a key the node keeps for itself (its id,
 * segment, kind, name or stamps), or after a content container but of another
 * kind. A document's content and its node's meta share one map, so kept, the
 * first would rewrite the node — hiding it from every listing, or naming it at
 * any length — from a grant that may only edit content. Nothing of the write
 * was kept.
 */
export class RootNoDocumentHoldsError extends SyncWriteRefusalError {
  readonly code = 'invalid_document_root'
  readonly status = 400

  constructor(public readonly roots: readonly string[]) {
    super(
      `This update adds root containers a workspace document cannot hold (${roots.map((root) => JSON.stringify(root)).join(', ')}): a document's id, segment, kind, name and timestamps belong to its place in the workspace, and a content container keeps the kind it has`,
    )
    this.name = 'RootNoDocumentHoldsError'
  }
}

/**
 * A sync write refused because it would leave a document's envelope saying
 * another kind than the document records — rewritten, deleted, or set on an
 * unkinded document to a kind its node does not record. Readers take the
 * envelope's word first, so kept, it would make a board read as a note to
 * every agent, search and render, and let a later markdown write replace the
 * board's nodes. Nothing of the write was kept.
 */
export class DocumentKindChangedError extends SyncWriteRefusalError {
  readonly code = 'document_kind_changed'
  readonly status = 400

  constructor(
    public readonly recorded: DocumentKind,
    public readonly kind: DocumentKind | undefined,
    public readonly documentId?: string,
  ) {
    const which = documentId === undefined ? 'a document' : `document ${documentId}`
    const says = kind === undefined ? 'no kind' : `"${kind}"`
    super(
      `This update would leave the envelope of ${which} saying ${says} while the document is recorded as "${recorded}"; a document keeps the kind it was created as`,
    )
    this.name = 'DocumentKindChangedError'
  }
}

/**
 * A sync write refused because it would give documents display names past
 * `DOCUMENT_NAME_MAX_LENGTH`, the bound every other name write holds. A name
 * stored longer before the bound, left or shortened, is let through.
 */
export class DocumentNameTooLongError extends SyncWriteRefusalError {
  readonly code = 'document_name_too_long'
  readonly status = 400

  constructor(public readonly paths: readonly string[]) {
    super(
      `This update would give ${paths.map((path) => JSON.stringify(path)).join(', ')} a display name past ${DOCUMENT_NAME_MAX_LENGTH} characters, the most a name may have`,
    )
    this.name = 'DocumentNameTooLongError'
  }
}

/**
 * A sync write refused because its changes build on a change this keeper
 * does not hold. Loro parks such changes outside the oplog, where no bound is
 * judged, and applies them as soon as a later import supplies what they
 * build on — so the instance holding them is dropped and nothing is kept.
 * 409 rather than a 4xx a client gives up on: sending again once the keeper
 * holds the change lands, which is the ordinary end of a keeper briefly
 * behind its own record.
 */
export class CausalGapError extends SyncWriteRefusalError {
  readonly code = 'causal_gap'
  readonly status = 409

  constructor() {
    super(
      'This update builds on changes this keeper has not received yet, so nothing of it was kept. Send the changes it builds on first',
    )
    this.name = 'CausalGapError'
  }
}

/** What a surface answers a sync write's throw with, or `undefined` for one it does not answer. */
export function syncWriteAnswer(err: unknown):
  | {
      readonly code: SyncWriteRefusalCode | typeof DOCUMENT_ENGINE_TRAP_CODE
      readonly status: 400 | 409 | 413 | 500
    }
  | undefined {
  if (err instanceof SyncWriteRefusalError) return { code: err.code, status: err.status }
  // The operation has already dropped the instance the engine poisoned, so
  // the caller is told the engine failed, in the code `/api/v1` answers it
  // with, and not that its bytes were malformed.
  if (err instanceof DocumentEngineTrapError)
    return { code: DOCUMENT_ENGINE_TRAP_CODE, status: 500 }
  return undefined
}

/** A throw the sync write raises on purpose and its caller answers, not a refused import. */
export function isSyncWriteRefusal(err: unknown): boolean {
  return syncWriteAnswer(err) !== undefined
}
