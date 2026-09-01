/**
 * The spatial text node's editor: a positioned CodeMirror overlay speaking
 * the SAME markdown as the document editor — one grammar (GFM), one
 * highlight style, one set of wrap shortcuts and list behaviors — so what
 * a hand learns in one surface transfers to the other.
 *
 * What stays node-shaped is the EXIT semantics, unchanged from the
 * textarea this replaces:
 * - ⌘/Ctrl+Enter commits and closes. It deliberately outranks the
 *   document editor's Mod-Enter task toggle: an overlay's most important
 *   verb is "done", and this binding predates the grammar upgrade.
 * - losing focus commits — nothing typed is ever lost to a stray click.
 * - Escape cancels (the gesture reducer decides what a cancel means for a
 *   just-created node).
 * `finishedRef` makes the commit/cancel transition terminal, exactly as
 * the textarea's doc described: once either has fired, the other is a
 * no-op, so Escape-then-blur cannot resurrect a discarded value. And
 * `mountedRef` guards the unmount path the textarea also guarded:
 * `EditorView.destroy()` blurs a focused content DOM, and on the everyday
 * click-away exit the gesture reducer has ALREADY committed the pending
 * text — a destroy-fired blur re-committing through this component's
 * stale pre-unmount closure would write a duplicate set-text every time.
 *
 * The wrapper carries the node's own fill/font/padding (style parity with
 * the rendered SVG); an OPAQUE background is load-bearing — it is what
 * hides the committed render underneath while editing.
 */

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { GFM } from '@lezer/markdown'
import { type CSSProperties, useLayoutEffect, useRef } from 'react'
import { EditorExitHint } from '../EditorExitHint.js'
import { markdownStyleKeymap } from '../markdown-editor/editor-verbs.js'
import { exitEmptyListItem } from '../markdown-editor/exit-empty-list-item.js'
import { markdownHighlightStyle } from '../markdown-editor/SourcePane.js'
import type { Box } from './geometry.js'

export interface MarkdownNodeEditorProps {
  readonly box: Box
  readonly initialText: string
  readonly style?: CSSProperties
  readonly testId?: string
  readonly onCommit: (text: string) => void
  readonly onCancel: () => void
  readonly onChange?: (text: string) => void
}

export function MarkdownNodeEditor({
  box,
  initialText,
  style,
  testId = 'text-node-editor',
  onCommit,
  onCancel,
  onChange,
}: MarkdownNodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const finishedRef = useRef(false)
  const mountedRef = useRef(false)
  // Latest callbacks without recreating the EditorView per parent render.
  const callbacksRef = useRef({ onCommit, onCancel, onChange })
  callbacksRef.current = { onCommit, onCancel, onChange }

  // useLayoutEffect, not useEffect: passive cleanups run AFTER React has
  // detached the host DOM, and detaching a focused contentDOM fires a
  // native blur while our handler is still attached and mountedRef is
  // still true — the duplicate-commit hole in person. A layout cleanup
  // runs BEFORE the detach, so destroy()'s own blur is the only one left,
  // and the mounted guard retires it.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return

    const commit = (view: EditorView) => {
      if (!mountedRef.current || finishedRef.current) return
      finishedRef.current = true
      callbacksRef.current.onCommit(view.state.doc.toString())
    }
    const cancel = () => {
      if (finishedRef.current) return
      finishedRef.current = true
      callbacksRef.current.onCancel()
    }

    const state = EditorState.create({
      doc: initialText,
      extensions: [
        markdown({ extensions: [GFM] }),
        // The exit verbs outrank EVERYTHING, including the language
        // keymap's Enter continuation and the style keymap's Mod-Enter.
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: (view) => {
                commit(view)
                return true
              },
            },
            {
              key: 'Escape',
              run: () => {
                cancel()
                return true
              },
            },
            { key: 'Enter', run: exitEmptyListItem },
          ]),
        ),
        syntaxHighlighting(markdownHighlightStyle),
        history(),
        keymap.of([...markdownStyleKeymap, ...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacksRef.current.onChange?.(update.state.doc.toString())
        }),
        EditorView.domEventHandlers({
          blur: (_event, view) => {
            commit(view)
            return false
          },
        }),
        // Inherit the node's own typography from the wrapper — the parity
        // styles live there so the SVG render and the editor agree.
        EditorView.theme({
          '&': { height: '100%', backgroundColor: 'transparent' },
          '.cm-scroller': {
            fontFamily: 'inherit',
            fontSize: 'inherit',
            lineHeight: 'inherit',
            overflow: 'auto',
          },
          '.cm-content': { padding: '0', caretColor: 'currentColor' },
          '.cm-line': { padding: '0' },
          '&.cm-focused': { outline: 'none' },
        }),
      ],
    })
    mountedRef.current = true
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    view.focus()
    // Continue typing where the text ends — programmatic focus leaves the
    // caret at position 0, which reads as "my text got replaced".
    view.dispatch({ selection: { anchor: view.state.doc.length } })

    return () => {
      // BEFORE destroy: EditorView.destroy() blurs a focused content DOM,
      // and that blur must find this editor already retired.
      mountedRef.current = false
      viewRef.current = null
      view.destroy()
    }
    // Mount-once by design: initialText is the seed, later parent renders
    // must not reset the document under the caret.
  }, [])

  return (
    <>
      <div
        ref={hostRef}
        aria-keyshortcuts="Meta+Enter Control+Enter"
        data-testid={testId}
        data-editor-overlay
        // Caret placement must not bubble into the root's hit-test and turn
        // into a move gesture that unmounts this editor mid-edit.
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          boxSizing: 'border-box',
          overflow: 'hidden',
          // Explicit, because the canvas root turns selection OFF and this
          // inherits from it.
          userSelect: 'text',
          ...style,
        }}
      />
      <EditorExitHint style={{ position: 'absolute', left: box.x, top: box.y + box.height + 6 }} />
    </>
  )
}
