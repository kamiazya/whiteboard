import { z } from 'zod'

/**
 * The most characters (UTF-16 code units, which `z.string().max` counts) one
 * text node's text may carry when it is written.
 *
 * The cost is laying the text out, not storing it: a write sizes the box (or
 * checks the named height) by measuring every line with the daemon's font,
 * which is LINEAR in the text at about 60 µs a character for prose and 190 for
 * one unbroken run of letters, broken into a line per box width. Measured
 * through the real store, one node.add at width 200
 * (`mcp-server/scripts/measure/text-node-write-cost.mjs`, quiet 4-core
 * machine): prose at 4 Ki ~0.47 s CPU, 16 Ki ~1.06 s, 64 Ki ~3.8 s; one
 * unbroken run at 8 Ki ~1.6 s, 16 Ki ~2.4 s. A later edit of the same board
 * does not pay it again (~20 ms). 8 Ki keeps the worst shape near the second
 * one markdown write is allowed, and is about three pages of prose — far more
 * than a box on a board shows; a longer text is a document.
 */
export const NODE_TEXT_MAX_CHARS = 8 * 1024

/**
 * The text a tool or route accepts for one text node, whole. One definition
 * so a write is refused the same way whichever op it arrives through. The
 * STORED node stays unbounded: a node written before the limit must still
 * read, and still take an edit that does not grow it.
 */
export const nodeTextInputSchema = z
  .string()
  .max(
    NODE_TEXT_MAX_CHARS,
    `node text is longer than the ${NODE_TEXT_MAX_CHARS}-character limit for one node; split it across nodes, or put it in a markdown document and embed that`,
  )
