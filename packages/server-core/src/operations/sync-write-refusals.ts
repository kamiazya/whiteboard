// The refusals a sync write raises on purpose, and the one answer each gets.
// Every surface that runs a sync write — a document's update, the workspace
// document's update and promote — answers them through `syncWriteAnswer`, so
// a refusal added here reaches each surface with the same code and status.
import { SYNC_TEXT_BREACH_CODES, type SyncTextBreach } from '@kamiazya/whiteboard-loro-adapter'
import {
  COMMENT_MESSAGE_LIMIT_PHRASE,
  DOCUMENT_NAME_MAX_LENGTH,
  DOCUMENT_PATH_MAX_LENGTH,
  LABEL_LIMIT_PHRASE,
  MARKDOWN_MAX_CHARS,
  NODE_LOCATION_LIMIT_PHRASE,
  NODE_TEXT_LIMIT_PHRASE,
  type SyncWriteRefusalCode,
  TAG_COUNT_LIMIT_PHRASE,
  TAG_LENGTH_LIMIT_PHRASE,
} from '@kamiazya/whiteboard-model'
import { DOCUMENT_ENGINE_TRAP_CODE, DocumentEngineTrapError } from '../document-io.js'

/**
 * A sync write the keeper refused for what its bytes would do. Nothing of the
 * write was kept. The code and status are the class's own, so a refusal
 * cannot exist without the answer every surface gives it.
 */
export abstract class SyncWriteRefusalError extends Error {
  abstract readonly code: SyncWriteRefusalCode
  abstract readonly status: 400 | 413
}

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

function bodyRefusalMessage({ shape, chars }: BreachOf<'run' | 'body'>, at?: RefusedIn): string {
  if (at === undefined) {
    return shape === 'run'
      ? `This update inserts ${chars} characters in one piece, past the ${MARKDOWN_MAX_CHARS}-character limit for one write; split the content across documents`
      : `This update would make a document body ${chars} characters long, past the ${MARKDOWN_MAX_CHARS}-character limit for one document; split the content across documents`
  }
  const where = JSON.stringify(at.path)
  const now =
    at.bodyChars === undefined ? '' : `, though its body is ${at.bodyChars} characters now`
  return shape === 'run'
    ? `The document at ${where} holds in its history one insert of ${chars} characters, past the ${MARKDOWN_MAX_CHARS}-character limit for one write${now}. Merging that history into a workspace that already holds documents replays it; a workspace with no documents yet takes the record whole`
    : `The document at ${where} has a body of ${chars} characters, past the ${MARKDOWN_MAX_CHARS}-character limit for one document; split it across documents`
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
  readonly status = 413
}

/**
 * A run longer than `MARKDOWN_MAX_CHARS` inserted in one piece, or a markdown
 * body left longer than that and longer than it was.
 */
class MarkdownBodyTooLargeError extends TextBreachRefusalError {
  readonly code = SYNC_TEXT_BREACH_CODES.body

  constructor(
    readonly breach: BreachOf<'run' | 'body'>,
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
 * A link's URL or a file's path or subpath added or grown past
 * `NODE_LOCATION_MAX_CHARS` — the bound every tool write holds, since each
 * render of the board lays it out again as the node's label.
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
    case 'run':
    case 'body':
      return new MarkdownBodyTooLargeError(breach, at)
  }
}

/**
 * A sync write refused because it would put documents at paths
 * `documentPathSchema` refuses — off the segment grammar, or past
 * `DOCUMENT_PATH_MAX_LENGTH` — a path every listing and search of the
 * workspace then fails on. Nothing of the write was kept. The message names
 * both rules, since a path can break either.
 */
export class OffGrammarPathError extends SyncWriteRefusalError {
  readonly code = 'invalid_path'
  readonly status = 400

  constructor(public readonly paths: readonly string[]) {
    const quoted = paths.map((path) => JSON.stringify(path)).join(', ')
    super(
      `This update would put documents at paths this keeper cannot store: ${quoted}. A path may be at most ${DOCUMENT_PATH_MAX_LENGTH} characters, and each segment may hold only ASCII letters, digits and interior hyphens`,
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

/** What a surface answers a sync write's throw with, or `undefined` for one it does not answer. */
export function syncWriteAnswer(err: unknown):
  | {
      readonly code: SyncWriteRefusalCode | typeof DOCUMENT_ENGINE_TRAP_CODE
      readonly status: 400 | 413 | 500
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
