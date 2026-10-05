// The words a text bound is refused in, for every door that refuses it: the
// editor that holds a draft to the bound, the paste or copy that would make
// one past it, and the keeper's refusal of a write that got through. One
// module, so a bound refused in two places is refused in one voice, and
// `limit-notice-surface.test.ts` fails on these words written anywhere else.
import {
  COMMENT_MESSAGE_MAX_CHARS,
  LABEL_MAX_CHARS,
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  type SyncWriteRefusalCode,
} from '@kamiazya/whiteboard-model'

// en-US whatever the browser's locale: a notice and the keeper's own message
// then print one limit the same way, and a test can assert either.
const COUNT = new Intl.NumberFormat('en-US')

const MARKDOWN_BODY_ADVICE = 'Split the content across documents.'
const COMMENT_MESSAGE_ADVICE = 'Continue in a reply.'

/** "N characters, past the M-character limit for one X" — the clause every notice ends on. */
function pastLimit(length: number, max: number, one: string): string {
  return `${COUNT.format(length)} characters, past the ${COUNT.format(max)}-character limit for one ${one}`
}

/**
 * A markdown body's edit or adoption that was not made. `max` is the bound
 * the editor was built with, which is `MARKDOWN_MAX_CHARS` outside a test.
 */
export function markdownBodyNotice(
  verb: 'added' | 'adopted',
  length: number,
  max: number = MARKDOWN_MAX_CHARS,
): string {
  return `Not ${verb}: the document would be ${pastLimit(length, max, 'document')}. ${MARKDOWN_BODY_ADVICE}`
}

/**
 * An edit to a node's text that was not made, wherever that text is edited —
 * in the node's own box or over the canvas. Short, because the box may be a
 * few lines tall.
 */
export function nodeTextEditNotice(length: number): string {
  return `Not added: the node would be ${pastLimit(length, NODE_TEXT_MAX_CHARS, 'node')}.`
}

/** Plain text pasted onto the canvas that made no node. */
export function pastedTextNotice(length: number): string {
  return `Not pasted: the text is ${pastLimit(length, NODE_TEXT_MAX_CHARS, 'node')}. Put it in a markdown document, or paste it in parts.`
}

/** A paste or duplicate of nodes that made nothing, naming the longest node's text. */
export function copiedNodeTextNotice(verb: 'pasted' | 'duplicated', length: number): string {
  return `Not ${verb}: a node's text is ${pastLimit(length, NODE_TEXT_MAX_CHARS, 'node')}. Shorten it first.`
}

/** An edit to an edge, line or group label that was not made. */
export function labelNotice(length: number): string {
  return `Not added: the label would be ${pastLimit(length, LABEL_MAX_CHARS, 'label')}.`
}

/** An edit to a comment draft that was not made. */
export function commentMessageNotice(length: number): string {
  return `Not added: the comment would be ${pastLimit(length, COMMENT_MESSAGE_MAX_CHARS, 'comment')}. ${COMMENT_MESSAGE_ADVICE}`
}

/**
 * Why a keeper refused a write past a text bound, for the notice above the
 * page. The refusal carries no length, so these name the bound rather than
 * a count.
 */
export const KEEPER_LIMIT_REASON = {
  markdown_too_large: `It would make this document longer than one document may be. ${MARKDOWN_BODY_ADVICE}`,
  node_text_too_large:
    'It would give a node more text than one node may hold. Split it across nodes, or put it in a markdown document and embed that.',
  label_too_large:
    'It would give a label more text than one label may hold. Put longer text in a node.',
  comment_too_large: `It would make a comment longer than one comment may be. ${COMMENT_MESSAGE_ADVICE}`,
} as const satisfies Partial<Record<SyncWriteRefusalCode, string>>
