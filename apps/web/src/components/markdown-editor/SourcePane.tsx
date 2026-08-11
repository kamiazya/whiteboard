import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { GFM } from '@lezer/markdown'
import { useEffect, useRef } from 'react'
import { minimalChange } from './minimal-change.js'

// Wraps each selection range in `delimiter` (Mod-b -> **, Mod-i -> *). A
// collapsed selection inserts an empty pair and parks the cursor between
// the delimiters so the next keystroke lands inside. Toggling (detecting
// an already-wrapped range and unwrapping) is deliberately not attempted:
// markdown emphasis nesting makes reliable detection lexer work, and a
// wrong unwrap corrupts text — insert-only is predictable.
function wrapSelectionWith(delimiter: string): StateCommand {
  return ({ state, dispatch }) => {
    const changes = state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: delimiter },
        { from: range.to, insert: delimiter },
      ],
      range: EditorSelection.range(range.from + delimiter.length, range.to + delimiter.length),
    }))
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }))
    return true
  }
}

const styleKeymap = [
  { key: 'Mod-b', run: wrapSelectionWith('**') },
  { key: 'Mod-i', run: wrapSelectionWith('*') },
]

/**
 * Markdown token styling, as class names rather than inline colors: the
 * app's palette lives in CSS custom properties that already flip with the
 * theme (`:root` / `.dark` in index.css), so the rules for these classes go
 * there too and dark mode needs no second definition here.
 *
 * The palette is deliberately achromatic (every token is `oklch(L 0 0)`),
 * so structure is carried by WEIGHT, SLANT and CONTRAST instead of hue —
 * a syntax rainbow would be the one colorful surface in the whole app.
 * Markers (`#`, `-`, `**`) recede rather than highlight: they are scaffolding
 * for the prose, and reading them as loudly as the prose inverts the point.
 *
 * `HeaderMark` and friends carry BOTH their own `processingInstruction` tag
 * and the enclosing heading's, and a `HighlightStyle` applies every matching
 * rule — so `.cm-md-marker` has to win on the shared properties by order in
 * the stylesheet, not by being the only match.
 */
const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, class: 'cm-md-heading' },
  { tag: tags.strong, class: 'cm-md-strong' },
  { tag: tags.emphasis, class: 'cm-md-emphasis' },
  { tag: tags.strikethrough, class: 'cm-md-strikethrough' },
  { tag: tags.link, class: 'cm-md-link' },
  { tag: tags.url, class: 'cm-md-url' },
  { tag: tags.monospace, class: 'cm-md-code' },
  { tag: tags.quote, class: 'cm-md-quote' },
  { tag: tags.list, class: 'cm-md-list' },
  { tag: tags.contentSeparator, class: 'cm-md-separator' },
  { tag: tags.labelName, class: 'cm-md-label' },
  { tag: tags.processingInstruction, class: 'cm-md-marker' },
])

export interface SourcePaneProps {
  value: string
  onChange: (next: string) => void
  className?: string
  /** Focus the editor as soon as it mounts (fresh-note flows). */
  autoFocus?: boolean
}

/**
 * Minimal CodeMirror 6 host — just `EditorState` + `EditorView` +
 * `markdown()` and an update listener. Deliberately not `basicSetup`'s
 * kitchen sink (line numbers, search panel, etc.): this is an editing
 * surface for a markdown canvas, not a general-purpose IDE.
 */
export function SourcePane({ value, onChange, className, autoFocus = false }: SourcePaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Always holds the latest onChange without forcing the effect below to
  // re-run (and recreate the EditorView) on every parent re-render.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        // GFM, because the preview pane parses through canvas-codec's
        // pipeline (`remark-parse` + `remark-gfm` + `remark-math`) and
        // `markdown()`'s default base is plain CommonMark. Left unmatched,
        // the two panes disagree about what the document even IS: a
        // `~~strikethrough~~` or a table renders in the preview while
        // staying unrecognized, and therefore unstyled, in the source.
        // `markdownLanguage` would also cover GFM but throws in
        // Subscript/Superscript/Emoji, which canvas-codec does NOT parse —
        // that trades this mismatch for its mirror image. Math is still
        // unmatched: canvas-codec parses it, but the preview degrades it to
        // an escaped-source placeholder anyway (see render-preview.ts), so
        // there is nothing yet for a source-side math grammar to agree with.
        markdown({ extensions: [GFM] }),
        syntaxHighlighting(markdownHighlightStyle),
        history(),
        // styleKeymap precedes defaultKeymap so Mod-b/Mod-i win over any
        // default binding; indentWithTab keeps Tab in the editor (Escape
        // then Tab remains the keyboard escape hatch, per CodeMirror's
        // own accessibility guidance).
        keymap.of([...styleKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        // Prose, not code: long paragraphs soft-wrap instead of growing a
        // horizontal scrollbar.
        EditorView.lineWrapping,
        // Fill the host pane instead of sizing to content: without a
        // bounded height the scroller never scrolls and the pane collapses
        // to its padding inside a flex row.
        EditorView.theme({
          '&': { height: '100%', width: '100%' },
          '.cm-scroller': { overflow: 'auto' },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
      ],
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    if (autoFocus) view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Intentionally created once per mount — external `value` changes are
    // reconciled below, not by recreating the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    // Guard against an edit loop: dispatching every re-render (even with an
    // identical `value`) would reset the cursor/selection under the user on
    // every keystroke, since a controlled parent typically echoes the same
    // value straight back in via `onChange`.
    if (current === value) return
    // Only the span that actually differs. CodeMirror maps the selection
    // through a change, so a whole-document replace collapses every caret
    // and selection inside it to a boundary — which is the entire document.
    // Confining the range keeps every position outside it untouched, and is
    // what makes a remote CRDT update land without yanking the local caret
    // out of the word being typed.
    view.dispatch({ changes: minimalChange(current, value) })
  }, [value])

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}
      data-testid="markdown-source-pane"
    />
  )
}
