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
 * The wrapper carries the node's font/padding (style parity with the
 * rendered SVG) and is TRANSPARENT: the scene below keeps drawing the
 * node's chrome — silhouette, stroke, fill — and suppresses only this
 * node's text (`suppressedBodyNodeIds`), so nothing is doubled and a
 * non-rectangular node keeps its shape for the whole edit. The opaque
 * background this replaced existed solely to hide the committed text.
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
  /**
   * Vertically centre content that fits, the way the committed render
   * places a SHAPED node's text (placeInNode's diagram-symbol
   * convention). Read once at mount, like `initialText` — the editor
   * remounts per edit.
   */
  readonly centerContent?: boolean
  /**
   * Where the exit hint's top edge goes, in the same canvas coordinates
   * as `box`. A shaped node's editor sits in the silhouette's INSCRIBED
   * box, and a hint hung from that box would land inside the shape — the
   * caller passes the full node box's bottom instead. Defaults to just
   * under `box`.
   */
  readonly exitHintTop?: number
  /**
   * Screen-size correction for the exit strip: the strip is positioned in
   * canvas coordinates and would otherwise scale with the zoom, and a tap
   * target has a screen size, not a canvas size. Callers pass `1 / zoom`.
   */
  readonly exitHintScale?: number
  readonly style?: CSSProperties
  readonly testId?: string
  readonly onCommit: (text: string) => void
  readonly onCancel: () => void
  readonly onChange?: (text: string) => void
}

export function MarkdownNodeEditor({
  box,
  initialText,
  centerContent = false,
  exitHintTop,
  exitHintScale,
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

  // useLayoutEffect, not useEffect: passive cleanups run AFTER React has
  // detached the host DOM, and detaching a focused contentDOM fires a
  // native blur while our handler is still attached and mountedRef is
  // still true — the duplicate-commit hole in person. A layout cleanup
  // runs BEFORE the detach, so destroy()'s own blur is the only one left,
  // and the mounted guard retires it.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return

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
          '&': centerContent
            ? // minHeight 0 lets the column-flex child SHRINK below its
              // content height, so overflow reaches the scroller instead of
              // being clipped by the host's overflow:hidden.
              { maxHeight: '100%', minHeight: '0', backgroundColor: 'transparent' }
            : { height: '100%', backgroundColor: 'transparent' },
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
          // Centre-what-fits, matching the committed render's shaped-node
          // placement; past the middle the editor grows downward as the
          // committed centring would recompute per added line.
          ...(centerContent
            ? { display: 'flex', flexDirection: 'column' as const, justifyContent: 'center' }
            : {}),
          // Explicit, because the canvas root turns selection OFF and this
          // inherits from it.
          userSelect: 'text',
          ...style,
        }}
      />
      <EditorExitHint
        onDone={() => {
          const view = viewRef.current
          if (view !== null) commit(view)
        }}
        onCancel={cancel}
        canvasOverlay
        placement={{
          left: box.x,
          right: box.x + box.width,
          top: exitHintTop ?? box.y + box.height + 6,
          scale: exitHintScale,
        }}
      />
    </>
  )
}
