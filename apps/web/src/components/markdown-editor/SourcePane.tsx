import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import {
  EditorState,
  type Extension,
  Prec,
  type StateCommand,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { GFM } from '@lezer/markdown'
import { type RefObject, useEffect, useRef } from 'react'
import {
  type ActiveMarkdownEditor,
  clearActiveMarkdownEditor,
  setActiveMarkdownEditor,
} from './active-markdown-editor.js'
import { markdownStyleKeymap } from './editor-verbs.js'
import { exitEmptyListItem } from './exit-empty-list-item.js'
import { headingLevelAt } from './line-prefix.js'
import { minimalChange } from './minimal-change.js'
import { rangeToActOn } from './word-at.js'

/**
 * The range a surface that ASKS the user something (the link picker) will
 * write to when it finally commits.
 *
 * It has to be a `StateField` rather than a remembered pair of offsets: the
 * dialog is not modal, so the document can change under it, and text typed
 * BEFORE the range shifts every later position. CodeMirror maps positions
 * through a change set for exactly this, so the pin travels with the text it
 * points at instead of pointing at whatever now occupies those offsets.
 *
 * Bias points INWARD at both ends (`1` at the start, `-1` at the end) so an
 * insertion at either boundary stays OUTSIDE the pinned range: text typed
 * immediately before the word must not become part of what the link
 * replaces. The outward-looking pair is the intuitive choice and is wrong —
 * `mapPos(from, -1)` keeps the start before an insertion at that offset, so
 * the range swallows it.
 */
const setPinnedRange = StateEffect.define<{ from: number; to: number } | null>()

const pinnedRange = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setPinnedRange)) return effect.value
    if (value === null) return null
    return { from: tr.changes.mapPos(value.from, 1), to: tr.changes.mapPos(value.to, -1) }
  },
})

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
export const markdownHighlightStyle = HighlightStyle.define([
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
  /**
   * Runs any editing command against the live view — the seam the catalog
   * drives, so a new verb is a new command rather than a new API method.
   * `wrapSelection` used to sit beside it, taking delimiters instead of a
   * command; every caller now reads its delimiters from
   * `MARKDOWN_EDITOR_VERBS` and arrives here as an ordinary command.
   */
  run: (command: StateCommand) => void
  /** Heading level of the line the caret sits on; 0 for body text. */
  headingLevel: () => number
  /**
   * Pins the range an inline verb would act on — the selection, else the
   * caret's word — and answers the text it holds.
   *
   * For a surface that commits LATER (the link picker): the caret can move
   * and the document can change under a non-modal dialog, and the range the
   * user was shown must still be the range that gets written.
   */
  pinScope: () => { text: string }
  /** Replaces the pinned range with `markup` and clears the pin. */
  replacePinned: (markup: string) => void
  /** Drops the pin without writing anything. */
  clearPin: () => void
  focus: () => void
  /**
   * The 1-based document line at the top of the visible scroll area, plus
   * the scrolled-past fraction of that line's own height — wrapped lines
   * make line height non-uniform, so this goes through CodeMirror's block
   * geometry rather than dividing scrollTop by an assumed line height.
   */
  topVisibleLine: () => number
  /**
   * The last line with any pixel on screen, by the same block geometry as
   * `topVisibleLine` — a wrapped or fenced line is taller than the rest, so
   * a count derived from an assumed line height would drift.
   */
  bottomVisibleLine: () => number
  /** Scrolls so `line` sits in the middle of the viewport. */
  revealLine: (line: number) => void
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
  /**
   * Host-supplied CodeMirror extensions, appended at view creation — the
   * seam a composition root uses to bind this editor to a CRDT document
   * (loro-codemirror). The view is created once per mount, so a host that
   * gains its extension later must remount (key) rather than expect a
   * live reconfigure.
   */
  extensions?: readonly Extension[]
  /**
   * When false, external `value` changes are NOT reconciled into the view
   * — for CRDT-bound hosts, where the binding itself applies remote
   * changes and a second reconcile path would race it and double-apply.
   * The view's content then flows only editor->out. Default true.
   */
  reconcileExternalValue?: boolean
  /**
   * Lets the keyboard-docked bar's Link slot open the editor's picker.
   * Answers whether a picker opened; undefined means the pane has none and
   * the bar wraps instead.
   */
  onRequestLinkPicker?: () => boolean
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
  extensions,
  reconcileExternalValue = true,
  onRequestLinkPicker,
}: SourcePaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Always holds the latest onChange without forcing the effect below to
  // re-run (and recreate the EditorView) on every parent re-render.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onRequestLinkPickerRef = useRef(onRequestLinkPicker)
  onRequestLinkPickerRef.current = onRequestLinkPicker
  // Filled once the view exists; the focus/blur handlers below read it lazily.
  const activeRef = useRef<ActiveMarkdownEditor | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        // GFM, because the preview pane parses through codec's
        // pipeline (`remark-parse` + `remark-gfm` + `remark-math`) and
        // `markdown()`'s default base is plain CommonMark. Left unmatched,
        // the two panes disagree about what the document even IS: a
        // `~~strikethrough~~` or a table renders in the preview while
        // staying unrecognized, and therefore unstyled, in the source.
        // `markdownLanguage` would also cover GFM but throws in
        // Subscript/Superscript/Emoji, which codec does NOT parse —
        // that trades this mismatch for its mirror image. Math is still
        // unmatched: codec parses it, but the preview degrades it to
        // an escaped-source placeholder anyway (see render-preview.ts), so
        // there is nothing yet for a source-side math grammar to agree with.
        markdown({ extensions: [GFM] }),
        pinnedRange,
        // Above the language keymap's own Enter (`markdown()` registers
        // lang-markdown's auto-continuation at high precedence): Enter on
        // an EMPTY list item must delete the marker, not march it down
        // another line. Everywhere else this reports unhandled and
        // continuation runs as usual.
        Prec.highest(keymap.of([{ key: 'Enter', run: exitEmptyListItem }])),
        syntaxHighlighting(markdownHighlightStyle),
        history(),
        // styleKeymap precedes defaultKeymap so Mod-b/Mod-i win over any
        // default binding; it also owns Tab (indent / outdent) and keeps it
        // in the editor.
        keymap.of([...markdownStyleKeymap, ...defaultKeymap, ...historyKeymap]),
        // Prose, not code: long paragraphs soft-wrap instead of growing a
        // horizontal scrollbar.
        EditorView.lineWrapping,
        ...(placeholderText !== undefined ? [placeholder(placeholderText)] : []),
        // Host extensions last, after every built-in: a CRDT binding must
        // observe the final document the built-ins produce.
        ...(extensions ?? []),
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
          // Out of the line's flow: upstream renders the placeholder as an
          // inline-block INSIDE the first line, and Android places the
          // native caret (and its selection handle) after that span — the
          // cursor appears mid-line on an empty document. Absolute takes
          // the span out of caret geometry; the <br> CodeMirror keeps in an
          // empty line preserves the line's height.
          '.cm-placeholder': { position: 'absolute' },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),
        // The touch formatting bar follows whichever host holds the caret.
        EditorView.domEventHandlers({
          focus: () => {
            if (activeRef.current !== null) setActiveMarkdownEditor(activeRef.current)
            return false
          },
          blur: () => {
            if (activeRef.current !== null) clearActiveMarkdownEditor(activeRef.current)
            return false
          },
        }),
      ],
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    activeRef.current = {
      run: (command) => {
        command({ state: view.state, dispatch: view.dispatch })
        view.focus()
      },
      headingLevel: () => headingLevelAt(view.state),
      openLinkPicker: () => onRequestLinkPickerRef.current?.() ?? false,
    }
    if (apiRef) {
      apiRef.current = {
        run: (command) => {
          command({ state: view.state, dispatch: view.dispatch })
          view.focus()
        },
        headingLevel: () => headingLevelAt(view.state),
        pinScope: () => {
          const scope = rangeToActOn(view.state)
          view.dispatch({ effects: setPinnedRange.of(scope) })
          return { text: view.state.doc.sliceString(scope.from, scope.to) }
        },
        replacePinned: (markup) => {
          const pin = view.state.field(pinnedRange)
          if (pin === null) return
          view.dispatch({
            changes: { from: pin.from, to: pin.to, insert: markup },
            selection: { anchor: pin.from + markup.length },
            effects: setPinnedRange.of(null),
            scrollIntoView: true,
            userEvent: 'input',
          })
          view.focus()
        },
        clearPin: () => {
          view.dispatch({ effects: setPinnedRange.of(null) })
        },
        focus: () => view.focus(),
        topVisibleLine: () => {
          const scrollTop = view.scrollDOM.scrollTop
          const block = view.lineBlockAtHeight(scrollTop)
          const line = view.state.doc.lineAt(block.from).number
          const fraction = block.height > 0 ? (scrollTop - block.top) / block.height : 0
          return line + Math.max(0, Math.min(1, fraction))
        },
        bottomVisibleLine: () => {
          const bottom = view.scrollDOM.scrollTop + view.scrollDOM.clientHeight
          const block = view.lineBlockAtHeight(bottom)
          const line = view.state.doc.lineAt(block.from).number
          // Fractional, like topVisibleLine: the last line is usually only
          // PARTLY on screen, and returning its start would make a viewport
          // marker computed from this pair too short by that remainder.
          const fraction = block.height > 0 ? (bottom - block.top) / block.height : 0
          return line + Math.max(0, Math.min(1, fraction))
        },
        revealLine: (line: number) => {
          const clamped = Math.max(1, Math.min(view.state.doc.lines, Math.round(line)))
          const pos = view.state.doc.line(clamped).from
          // `center` rather than the default `nearest`: a press on the rail
          // says "show me here", and nearest leaves an already-visible line
          // exactly where it was, which reads as the press doing nothing.
          view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
        },
      }
    }
    // Autofocus etiquette: claim focus unless a REAL surface already holds
    // it. This effect races two very different focus holders and must treat
    // them oppositely:
    // - the menu item that triggered the switch, inside a menu that is
    //   already dismissing — transient; claiming from it is the entire
    //   point of autofocus (left alone, it unmounts and drops focus on
    //   <body>, permanently, since this focus() is one-shot);
    // - the title input the user clicked BEFORE this deferred effect ran —
    //   real; claiming from it steals keystrokes mid-typing.
    // <body>/null also count as unclaimed.
    const holder = document.activeElement
    const holderIsTransient =
      holder === null || holder === document.body || holder.closest('[role="menu"]') !== null
    if (autoFocus && holderIsTransient) {
      view.focus()
    }

    return () => {
      if (activeRef.current !== null) clearActiveMarkdownEditor(activeRef.current)
      view.destroy()
      viewRef.current = null
      if (apiRef) apiRef.current = null
    }
    // Intentionally created once per mount — external `value` changes are
    // reconciled below, not by recreating the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    // A CRDT-bound host applies external changes through the binding
    // itself; reconciling here as well would race it and double-apply.
    if (!reconcileExternalValue) return
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
  }, [value, reconcileExternalValue])

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden' }}
      data-testid="markdown-source-pane"
    />
  )
}
