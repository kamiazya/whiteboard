import type { EditorState } from '@codemirror/state'

/**
 * Word segmentation via `Intl.Segmenter`, with no fallback.
 *
 * A whitespace split is not an acceptable substitute and there is no third
 * option: Japanese writes no spaces, so a whitespace run there is a whole
 * clause, and "bold the word under the caret" would bold the sentence. A
 * degraded path that quietly does that is worse than none.
 *
 * Requiring it costs nothing this app does not already require — Segmenter
 * has shipped since Chrome 87, Safari 14.1 and Firefox 125, all older than
 * the OPFS / SharedWorker / file-picker floor apps/web already sits on.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' })

/** The word-like run covering `offset` within `text`, or null if there is none. */
function wordWithin(text: string, offset: number): { from: number; to: number } | null {
  for (const seg of segmenter.segment(text)) {
    const from = seg.index
    const to = from + seg.segment.length
    if (seg.isWordLike === true && offset >= from && offset <= to) return { from, to }
  }
  return null
}

/**
 * What an inline verb should act on: the selection when there is one, else
 * the word under the caret.
 *
 * This is the seam that lets the editor's verbs work WITHOUT asking for a
 * selection first — the thing a phone cannot do comfortably (see the mobile
 * editing prior-art: every editor that solved this stopped requiring a
 * selection rather than building a better selection gesture). A caret on
 * whitespace or an empty line yields an empty range, which callers treat as
 * "nothing to do" rather than wrapping a space.
 */
export function rangeToActOn(state: EditorState): { from: number; to: number } {
  const main = state.selection.main
  if (!main.empty) return { from: main.from, to: main.to }
  const line = state.doc.lineAt(main.head)
  const word = wordWithin(line.text, main.head - line.from)
  if (word === null) return { from: main.head, to: main.head }
  return { from: line.from + word.from, to: line.from + word.to }
}
