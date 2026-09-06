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
 */
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'

interface MdastNodeish {
  readonly type?: string
  readonly value?: unknown
  readonly alt?: unknown
  readonly children?: readonly unknown[]
}

/**
 * One space per BLOCK boundary, none inside a block: the excerpt is one
 * line, so a paragraph break has to become something a reader can see, and
 * inline nodes must not gain spaces markdown never had (`a**b**c` is one
 * word).
 */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'blockquote',
  'code',
  'table',
  'tableRow',
  'thematicBreak',
])

function walk(node: unknown, out: string[]): void {
  if (node === null || typeof node !== 'object') return
  const { type, value, alt, children } = node as MdastNodeish
  // `alt` for an image: the text an author wrote is the only thing an image
  // contributes to a one-line summary.
  if (typeof value === 'string') out.push(value)
  else if (type === 'image' && typeof alt === 'string' && alt !== '') out.push(alt)
  if (Array.isArray(children)) for (const child of children) walk(child, out)
  if (type !== undefined && BLOCK_TYPES.has(type)) out.push(' ')
}

export function commentExcerpt(body: string): string {
  let root: unknown
  try {
    root = parseMarkdownBody(body)
  } catch {
    // A body mid-edit, or one another writer sent. The source is a worse
    // summary than the rendering and a better one than nothing.
    return body.trim()
  }
  const parts: string[] = []
  walk(root, parts)
  return parts.join('').replace(/\s+/g, ' ').trim()
}
