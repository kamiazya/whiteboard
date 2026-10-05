// A comment message, held where a person writes it to the bound the agent
// tools already hold it to. Each message is laid out on every render of the
// board and the rail, at a cost linear in its length, so a message past
// `COMMENT_MESSAGE_MAX_CHARS` is never made here.
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { COMMENT_MESSAGE_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { textLengthLimit } from './text-length-limit.js'

const COUNT = new Intl.NumberFormat('en-US')

/**
 * Every comment composer's limit — a new thread, a reply, an edit. The notice
 * is set small because it shares a bubble or a rail row with the draft.
 */
export const commentMessageLengthLimit: Extension = [
  // FIRST, and that order is the override: CodeMirror mounts the earliest
  // theme last, so it wins over the limit's own document-sized notice.
  EditorView.theme({
    '.cm-length-limit-notice': { padding: '2px 4px', fontSize: '11px', lineHeight: '1.3' },
  }),
  textLengthLimit(
    COMMENT_MESSAGE_MAX_CHARS,
    (length) =>
      `Not added: the comment would be ${COUNT.format(length)} characters, past its ${COUNT.format(COMMENT_MESSAGE_MAX_CHARS)}-character limit. Continue in a reply.`,
  ),
]
