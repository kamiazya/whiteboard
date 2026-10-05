import { NODE_TEXT_MAX_CHARS } from '@kamiazya/whiteboard-model'

const COUNT = new Intl.NumberFormat('en-US')

/**
 * Why an edit to a node's text was not made, wherever that text is edited —
 * in the node's own box or over the canvas — so the two doors onto one text
 * refuse it in one voice. Short, because the box may be a few lines tall.
 */
export function nodeTextEditRefusal(length: number): string {
  return `Not added: the node would be ${COUNT.format(length)} characters, past its ${COUNT.format(NODE_TEXT_MAX_CHARS)}-character limit.`
}
