import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorSelection, EditorState, Prec, type StateCommand } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { GFM } from '@lezer/markdown'
import { type RefObject, useEffect, useRef } from 'react'
import { exitEmptyListItem } from './exit-empty-list-item.js'
import { minimalChange } from './minimal-change.js'
import { toggleTaskCheckbox } from './toggle-task-checkbox.js'

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
  { key: 'Mod-e', run: wrapSelectionWith('`') },
  { key: 'Mod-Enter', run: toggleTaskCheckbox },
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

/**
 * Imperative surface the toolbar drives. Kept to commands that need the
 * live `EditorView` (selection, focus) — everything else flows through the
 * controlled `value`/`onChange` pair.
 */
export interface SourcePaneApi {
  wrapSelection: (delimiter: string) => void
  focus: () => void
  /**
   * The 1-based document line at the top of the visible scroll area, plus
   * the scrolled-past fraction of that line's own height — wrapped lines
   * make line height non-uniform, so this goes through CodeMirror's block
   * geometry rather than dividing scrollTop by an assumed line height.
   */
  topVisibleLine: () => number
}

export interface SourcePaneProps {
  value: string
  onChange: (next: string) => void
  className?: string
  /** Focus the editor as soon as it mounts (fresh-note flows). */
  autoFocus?: boolean
  /** Shown while the document is empty. */
  placeholderText?: string
  /** Receives the imperative API while the view is mounted, null after. */
  apiRef?: RefObject<SourcePaneApi | null>
}

/**
 * Minimal CodeMirror 6 host — just `EditorState` + `EditorView` +
 * `markdown()` and an update listener. Deliberately not `basicSetup`'s
 * kitchen sink (line numbers, search panel, etc.): this is an editing
 * surface for a markdown canvas, not a general-purpose IDE.
 */
export function SourcePane({
  value,
  onChange,
  className,
  autoFocus = false,
  placeholderText,
  apiRef,
}: SourcePaneProps) {
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
        // Above the language keymap's own Enter (`markdown()` registers
        // lang-markdown's auto-continuation at high precedence): Enter on
        // an EMPTY list item must delete the marker, not march it down
        // another line. Everywhere else this reports unhandled and
        // continuation runs as usual.
        Prec.highest(keymap.of([{ key: 'Enter', run: exitEmptyListItem }])),
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
        ...(placeholderText !== undefined ? [placeholder(placeholderText)] : []),
        // Fill the host pane instead of sizing to content: without a
        // bounded height the scroller never scrolls and the pane collapses
        // to its padding inside a flex row.
        //
        // Prose, so the writing surface reads like the app, not a terminal:
        // the scroller inherits the app font (CodeMirror's default is
        // monospace) — which is also what makes index.css's `.cm-md-code`
        // mono rule meaningful — and the content is a centered, bounded
        // column (~70ch) like every serious writing surface, instead of
        // lines that stretch across a widescreen pane.
        EditorView.theme({
          '&': { height: '100%', width: '100%', fontSize: '15px' },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: '1.7' },
          '.cm-content': {
            maxWidth: '70ch',
            margin: '0 auto',
            padding: '24px 0 120px',
            caretColor: 'var(--foreground)',
          },
          '.cm-line': { padding: '0 24px' },
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
    if (apiRef) {
      apiRef.current = {
        wrapSelection: (delimiter) => {
          wrapSelectionWith(delimiter)({ state: view.state, dispatch: view.dispatch })
          view.focus()
        },
        focus: () => view.focus(),
        topVisibleLine: () => {
          const scrollTop = view.scrollDOM.scrollTop
          const block = view.lineBlockAtHeight(scrollTop)
          const line = view.state.doc.lineAt(block.from).number
          const fraction = block.height > 0 ? (scrollTop - block.top) / block.height : 0
          return line + Math.max(0, Math.min(1, fraction))
        },
      }
    }
    if (autoFocus) view.focus()

    return () => {
      view.destroy()
      viewRef.current = null
      if (apiRef) apiRef.current = null
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
