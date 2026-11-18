/**
 * What a comment SAYS, as one line of plain text — the rail row's excerpt.
 *
 * A row is a summary clamped to two lines inside a button, so it cannot be
 * the rendered body: the body is drawn as SVG (`CommentBody`), and neither
 * `line-clamp` nor a button's semantics survive one. But it must not show
 * the source either, which is what it did — a reader scanning the rail saw
 * `**tighten**` while the card beside it drew emphasis.
 *
 * Deliberately a walk over the parsed body rather than over the LAID-OUT
 * one, even though the layout is the one producer of how a comment is
 * drawn. Layout puts the space between two words in an x offset rather than
 * in a string — `**tighten** this` lays out as the runs `tighten` and
 * `this` — so joining its runs yields `tightenthis`. The question this
 * answers is a different one from the question layout answers, and reusing
 * the wrong producer for it would be wrong quietly, in a summary nobody
 * reads closely.
 *
 * The walk is the Rust core's (`markdown_excerpt`, through search's
 * `markdownPlainText`), so the rail answers from the same parse the card
 * draws. Without a core — a realm that never installed one, or a boot whose
 * load failed — the row shows the source rather than waiting: the page awaits
 * the core before its first render, so this is the degraded path and not the
 * usual one, and the source still identifies the conversation.
 */
import { isSearchUnavailable, markdownPlainText } from '@kamiazya/whiteboard-search'

export function commentExcerpt(body: string): string {
  try {
    return markdownPlainText(body)
  } catch (err) {
    // No core in this realm, or a body past what it reads: the source is a
    // worse summary than the rendering and a better one than nothing.
    if (isSearchUnavailable(err)) return body.trim()
    throw err
  }
}
