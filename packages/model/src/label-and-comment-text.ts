import { z } from 'zod'

/**
 * The most characters (UTF-16 code units) one label may carry when it is
 * written: an edge's, a line's, or a group's.
 *
 * A label is laid out on every render of its board, not at its write, and the
 * cost is LINEAR in its length at about 10 µs a character, prose or one
 * unbroken run alike. Measured through the real store and the export measurer
 * (`mcp-server/scripts/measure/label-and-comment-cost.mjs`, 4-core machine),
 * one wb_scene_render of a two-box board with one edge label: 1 Ki ~18 ms,
 * 4 Ki ~52 ms, 16 Ki ~157 ms, 64 Ki ~0.6 s; a line or group label the same
 * within noise, and the write itself flat at ~15 ms. At 1 Ki the label's own
 * share is lost in the board's baseline, which is the point: a label is one
 * line of chrome, and 1 Ki is already a paragraph nobody reads on a line. A
 * longer text is a text node.
 */
export const LABEL_MAX_CHARS = 1024

/**
 * The label a tool or route accepts, whole. The STORED label stays unbounded:
 * one written before the limit must still read, and still take an edit that
 * leaves it alone.
 */
export const labelInputSchema = z
  .string()
  .max(
    LABEL_MAX_CHARS,
    `a label is longer than the ${LABEL_MAX_CHARS}-character limit; a longer text belongs in a text node`,
  )

/**
 * The most characters one comment message may carry when it is written.
 *
 * A message is laid out as markdown at the bubble's width, on the board for a
 * thread's opening message and in the rail for every one — the same per-
 * character cost as a text node's text, paid on every render rather than once.
 * Measured with the script above, one wb_scene_render of a board with one
 * comment: prose at 4 Ki ~0.32 s CPU, 16 Ki ~1.0 s, 64 Ki ~3.5 s; one
 * unbroken run at 4 Ki ~0.77 s, 16 Ki ~2.6 s, 64 Ki ~10 s. Half a text node's
 * 8 Ki, because a message has somewhere else to go that a node does not: a
 * longer one splits across replies at no loss, and 4 Ki is still several
 * hundred words.
 */
export const COMMENT_MESSAGE_MAX_CHARS = 4 * 1024

/** A comment message as a tool or route accepts it. Stored messages stay unbounded. */
export const commentMessageInputSchema = z
  .string()
  .min(1, 'a comment message must not be empty')
  .max(
    COMMENT_MESSAGE_MAX_CHARS,
    `a comment message is longer than the ${COMMENT_MESSAGE_MAX_CHARS}-character limit; split it across replies`,
  )
