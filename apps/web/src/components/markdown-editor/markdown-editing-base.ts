// What every CodeMirror markdown host in this app installs the same way, so
// a change to the shared baseline — a keymap, the highlight style, how the
// touch formatting bar follows the caret — is made once. A host keeps its
// own verbs, completion, theme and chrome around these.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import type { RefObject } from 'react'
import {
  type ActiveMarkdownEditor,
  clearActiveMarkdownEditor,
  setActiveMarkdownEditor,
} from './active-markdown-editor.js'
import { markdownStyleKeymap } from './editor-verbs.js'
import { emojiShortcodeMarks } from './emoji-shortcode-marks.js'
import { headingLevelAt } from './line-prefix.js'

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
 * The baseline a host installs AFTER its own `Prec.highest` verbs and the
 * language, and BEFORE its own theme and listeners.
 *
 * - `:rocket:` is drawn as 🚀 once the caret leaves it, unconditionally:
 *   every surface a host serves is drawn by the same `mdast-blocks` walk
 *   that expands the shortcode, so a host showing the source where the
 *   render shows the character would be previewing something that does not
 *   happen.
 * - The style keymap precedes the default keymap so Mod-b/Mod-i win over
 *   any default binding; it also owns Tab (indent / outdent) and keeps it
 *   in the editor.
 * - Prose, not code: long paragraphs soft-wrap instead of growing a
 *   horizontal scrollbar.
 */
export function markdownEditingBase(): Extension[] {
  return [
    syntaxHighlighting(markdownHighlightStyle),
    emojiShortcodeMarks(),
    history(),
    keymap.of([...markdownStyleKeymap, ...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
  ]
}

/**
 * The touch formatting bar follows whichever host holds the caret: the host
 * registers the handle in `activeRef` on focus and withdraws it on blur.
 * `onBlur` is the host's own departure handling, run after the withdrawal.
 */
export function followCaret(
  activeRef: RefObject<ActiveMarkdownEditor | null>,
  onBlur?: (event: FocusEvent, view: EditorView) => void,
): Extension {
  return EditorView.domEventHandlers({
    focus: () => {
      if (activeRef.current !== null) setActiveMarkdownEditor(activeRef.current)
      return false
    },
    blur: (event, view) => {
      if (activeRef.current !== null) clearActiveMarkdownEditor(activeRef.current)
      onBlur?.(event, view)
      return false
    },
  })
}

/**
 * The handle every host answers the same way, plus what this one adds
 * (a link picker, a comment composer).
 */
export function activeMarkdownEditorFor(
  view: EditorView,
  extras: Partial<ActiveMarkdownEditor> = {},
): ActiveMarkdownEditor {
  return {
    run: (command) => {
      command({ state: view.state, dispatch: view.dispatch })
      view.focus()
    },
    headingLevel: () => headingLevelAt(view.state),
    focus: () => view.focus(),
    selectedRange: () => {
      const { from, to } = view.state.selection.main
      return from === to ? null : { from, to }
    },
    ...extras,
  }
}
