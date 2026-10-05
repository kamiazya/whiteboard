// A markdown body held to `MARKDOWN_MAX_CHARS` where a person edits it.
import type { Extension } from '@codemirror/state'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { textLengthLimit } from '../../lib/text-length-limit.js'

const COUNT = new Intl.NumberFormat('en-US')

/** A markdown document's body, held to the size both keepers accept. */
export function markdownLengthLimit(limit: number = MARKDOWN_MAX_CHARS): Extension {
  return textLengthLimit(
    limit,
    (length) =>
      `Not added: this would make the document ${COUNT.format(length)} characters long, past the ${COUNT.format(limit)}-character limit. Split the content across documents.`,
  )
}
