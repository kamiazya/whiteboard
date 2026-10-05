// A comment message, held where a person writes it to the bound the agent
// tools already hold it to. Each message is laid out on every render of the
// board and the rail, at a cost linear in its length, so a message past
// `COMMENT_MESSAGE_MAX_CHARS` is never made here.
import type { Extension } from '@codemirror/state'
import { COMMENT_MESSAGE_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { commentMessageNotice } from './limit-notice.js'
import { textLengthLimit } from './text-length-limit.js'

/**
 * Every comment composer's limit — a new thread, a reply, an edit. The notice
 * is set small because it shares a bubble or a rail row with the draft.
 */
export const commentMessageLengthLimit: Extension = textLengthLimit(
  COMMENT_MESSAGE_MAX_CHARS,
  commentMessageNotice,
  { compact: true },
)
