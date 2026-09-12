import { syntaxTree } from '@codemirror/language'
import { type Extension, type Range, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { EMOJI_FONT_STACK } from '@kamiazya/whiteboard-facet-ui'
import { emojiShortcodeRanges } from '@kamiazya/whiteboard-plugin-visual/emoji/shortcode'

/**
 * `:rocket:` shown as 🚀 in the source pane, once it is finished being
 * written.
 *
 * The pane is where a person reads their own note, and a body full of
 * `:grinning_face:` is not what the render makes of it. So the source keeps
 * holding the shortcode — that is the stored form, decided 2026-09-11 — and
 * the pane draws over it.
 *
 * **The ranges come from `emojiShortcodeRanges`, which the renderer also
 * reads.** That is the whole design constraint here: a widget over a range
 * the renderer would not expand, or a shortcode left as text that the
 * renderer will replace, makes the pane a preview of something that does not
 * happen — worse than either behaviour on its own. One scanner, two readers.
 *
 * It reaches for `emoji/shortcode` and never `emoji/search`: a decoration is
 * computed synchronously on every view update, so it needs the small
 * read-path table rather than the 190KB search index the `:` completion
 * loads.
 */

class EmojiWidget extends WidgetType {
  constructor(
    private readonly char: string,
    private readonly source: string,
  ) {
    super()
  }

  // Two widgets over the same shortcode are interchangeable, so CodeMirror
  // may reuse the DOM instead of rebuilding it as the document shifts.
  override eq(other: EmojiWidget): boolean {
    return other.char === this.char && other.source === this.source
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.textContent = this.char
    // Read by the tests, and by anyone inspecting why a character is here
    // rather than the text they typed.
    span.dataset.emojiShortcode = this.source
    // The same reason the picker's cells carry it: left to the inherited UI
    // stack, several ordinary text faces claim the common emoji codepoints
    // as monochrome outlines.
    span.style.fontFamily = EMOJI_FONT_STACK
    // A widget is not selectable text, so the shortcode it stands for is the
    // only thing that can name it to a screen reader.
    span.setAttribute('aria-label', `:${this.source}:`)
    return span
  }
}

/**
 * Positions inside code, where a shortcode is the SUBJECT rather than a use.
 *
 * The renderer draws the same line: `mdast-blocks.ts` expands a text node and
 * deliberately never an `inlineCode`. Read off the syntax tree rather than by
 * matching backticks, because the tree is what the markdown grammar already
 * decided and a second parse of the same delimiters would disagree at the
 * edges.
 */
function inCode(view: EditorView, from: number, to: number): boolean {
  let found = false
  syntaxTree(view.state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.name.includes('Code')) found = true
      return !found
    },
  })
  return found
}

function marks(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { from: caretFrom, to: caretTo } = view.state.selection.main
  const pending: Array<Range<Decoration>> = []
  for (const visible of view.visibleRanges) {
    // Whole lines, so a shortcode straddling the viewport edge is scanned
    // once with its real offsets rather than half-matched at a boundary.
    const first = view.state.doc.lineAt(visible.from)
    const last = view.state.doc.lineAt(visible.to)
    for (let n = first.number; n <= last.number; n += 1) {
      const line = view.state.doc.line(n)
      for (const range of emojiShortcodeRanges(line.text)) {
        const from = line.from + range.from
        const to = line.from + range.to
        // Inclusive at both ends: the caret sits just past the closing colon
        // the instant the name is finished, and revealing there is what
        // stops the emoji appearing under the cursor mid-word.
        if (caretTo >= from && caretFrom <= to) continue
        if (inCode(view, from, to)) continue
        const name = line.text.slice(range.from + 1, range.to - 1)
        pending.push(
          Decoration.replace({ widget: new EmojiWidget(range.char, name) }).range(from, to),
        )
      }
    }
  }
  // `visibleRanges` is ordered, and so is each line's scan — but a builder
  // requires it globally, and sorting once is cheaper than trusting that.
  pending.sort((a, b) => a.from - b.from)
  for (const one of pending) builder.add(one.from, one.to, one.value)
  return builder.finish()
}

/**
 * The marks, for either host to install.
 *
 * A `ViewPlugin` rather than a `StateField` because the set depends on what
 * is VISIBLE as well as on the document — a note is scanned a screen at a
 * time rather than end to end on every keystroke.
 */
export function emojiShortcodeMarks(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = marks(view)
      }

      update(update: ViewUpdate): void {
        // Selection too: moving the caret into a shortcode is what reveals
        // it, so a plain `docChanged` guard would leave it drawn while
        // somebody tried to edit the name underneath.
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = marks(update.view)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}
