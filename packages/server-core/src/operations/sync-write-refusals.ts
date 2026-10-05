// The refusals a sync write raises on purpose, and the one answer each gets.
// Every surface that runs a sync write — a document's update, the workspace
// document's update and promote — answers them through `syncWriteAnswer`, so
// a refusal added here reaches each surface with the same code and status.
import {
  DOCUMENT_NAME_MAX_LENGTH,
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
} from '@kamiazya/whiteboard-model'
import type { ContainerID } from 'loro-crdt'
import { DOCUMENT_ENGINE_TRAP_CODE, DocumentEngineTrapError } from '../document-io.js'

/**
 * A sync write the keeper refused for what its bytes would do. Nothing of the
 * write was kept. The code and status are the class's own, so a refusal
 * cannot exist without the answer every surface gives it.
 */
export abstract class SyncWriteRefusalError extends Error {
  abstract readonly code: string
  abstract readonly status: 400 | 413
}

/** The document a refused run or body belongs to, when the caller could tell. */
export interface RefusedBody {
  readonly path: string
  /** The body's length today, which for a run found only in history is short. */
  readonly chars: number
}

function bodyRefusalMessage(shape: 'run' | 'body', chars: number, at?: RefusedBody): string {
  if (at === undefined) {
    return shape === 'run'
      ? `This update inserts ${chars} characters in one piece, past the ${MARKDOWN_MAX_CHARS}-character limit for one write; split the content across documents`
      : `This update would make a document body ${chars} characters long, past the ${MARKDOWN_MAX_CHARS}-character limit for one document; split the content across documents`
  }
  const where = JSON.stringify(at.path)
  return shape === 'run'
    ? `The document at ${where} holds in its history one insert of ${chars} characters, past the ${MARKDOWN_MAX_CHARS}-character limit for one write, though its body is ${at.chars} characters now. Merging that history into a workspace that already holds documents replays it; a workspace with no documents yet takes the record whole`
    : `The document at ${where} has a body of ${chars} characters, past the ${MARKDOWN_MAX_CHARS}-character limit for one document; split it across documents`
}

/**
 * A sync write refused because of what its bytes would do to a body: insert
 * one piece longer than `MARKDOWN_MAX_CHARS`, or leave a markdown body longer
 * than that and longer than it was. Nothing of the write was kept.
 *
 * `container` is the text container that broke it, for a caller that can
 * resolve it to a document; `at` is that document, once resolved.
 */
export class MarkdownBodyTooLargeError extends SyncWriteRefusalError {
  readonly code = 'markdown_too_large'
  readonly status = 413

  constructor(
    public readonly shape: 'run' | 'body',
    public readonly chars: number,
    public readonly container?: ContainerID,
    public readonly at?: RefusedBody,
  ) {
    super(bodyRefusalMessage(shape, chars, at))
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
export class NodeTextTooLargeError extends SyncWriteRefusalError {
  readonly code = 'node_text_too_large'
  readonly status = 413

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
export class OffGrammarPathError extends SyncWriteRefusalError {
  readonly code = 'invalid_path'
  readonly status = 400

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
export class UnreadableDocumentMetaError extends SyncWriteRefusalError {
  readonly code = 'unreadable_document_meta'
  readonly status = 400

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
export function syncWriteAnswer(
  err: unknown,
): { readonly code: string; readonly status: 400 | 413 | 500 } | undefined {
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
