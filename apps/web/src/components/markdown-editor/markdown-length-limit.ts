// A markdown body held to `MARKDOWN_MAX_CHARS` where a person edits it.
import type { Extension } from '@codemirror/state'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { markdownBodyNotice } from '../../lib/limit-notice.js'
import { textLengthLimit } from '../../lib/text-length-limit.js'

/** A markdown document's body, held to the size both keepers accept. */
export function markdownLengthLimit(limit: number = MARKDOWN_MAX_CHARS): Extension {
  return textLengthLimit(limit, (length) => markdownBodyNotice('added', length, limit))
}
