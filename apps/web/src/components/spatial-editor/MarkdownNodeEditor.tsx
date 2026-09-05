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
import type { CommentThread } from '@kamiazya/whiteboard-model'
import { GFM } from '@lezer/markdown'
import { type CSSProperties, useEffect, useLayoutEffect, useRef } from 'react'
import type { Box } from '../../lib/spatial/geometry.js'
import type { TextAnchor } from '../../lib/text-anchor.js'
import { textAnchorForSelection } from '../../lib/text-anchor-for-selection.js'
import { EditorExitHint } from '../EditorExitHint.js'
import {
  type ActiveMarkdownEditor,
  clearActiveMarkdownEditor,
  setActiveMarkdownEditor,
} from '../markdown-editor/active-markdown-editor.js'
import {
  annotationMarks,
  setAnnotationProjection,
} from '../markdown-editor/annotation-decorations.js'
import { markdownStyleKeymap } from '../markdown-editor/editor-verbs.js'
import { exitEmptyListItem } from '../markdown-editor/exit-empty-list-item.js'
import { headingLevelAt } from '../markdown-editor/line-prefix.js'
import { markdownHighlightStyle } from '../markdown-editor/SourcePane.js'

const isMenuTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[role="menu"]') !== null

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
  /**
   * The catalog's Comment seam: the selection as a text anchor over this
   * editor's document, for the host to attach to its node and open a
   * composer for — the note editor's `onComposeThread`, for a node.
   */
  readonly onRequestComment?: (anchor: TextAnchor) => boolean
  /**
   * The conversations about passages of THIS node's text, drawn as
   * highlights over the draft while it is edited (no gutter: the editor
   * sits in the node's own box). Offsets are into the node's text.
   */
  readonly threads?: readonly CommentThread[]
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
  onRequestComment,
  threads,
}: MarkdownNodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Filled once the view exists; the focus/blur handlers read it lazily.
  const activeRef = useRef<ActiveMarkdownEditor | null>(null)
  const finishedRef = useRef(false)
  const mountedRef = useRef(false)
  const onRequestCommentRef = useRef(onRequestComment)
  onRequestCommentRef.current = onRequestComment
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
        annotationMarks(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacksRef.current.onChange?.(update.state.doc.toString())
        }),
        EditorView.domEventHandlers({
          // The touch formatting bar follows whichever host holds the caret.
          focus: () => {
            if (activeRef.current !== null) setActiveMarkdownEditor(activeRef.current)
            return false
          },
          blur: (event, view) => {
            if (activeRef.current !== null) clearActiveMarkdownEditor(activeRef.current)
            // Focus moving INTO a menu is the editing catalog taking the
            // keyboard for its rows, not the user leaving the node: the
            // catalog acts on this editor and hands the caret back on
            // close, so the edit stays open. Any other departure commits.
            if (isMenuTarget(event.relatedTarget)) return false
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
    activeRef.current = {
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
      ...(onRequestCommentRef.current === undefined
        ? {}
        : {
            composeThread: () => {
              const { from, to } = view.state.selection.main
              if (from === to) return false
              const anchor = textAnchorForSelection(view.state.doc.toString(), from, to)
              if (anchor === null) return false
              return onRequestCommentRef.current?.(anchor) ?? false
            },
          }),
    }
    view.focus()
    // Continue typing where the text ends — programmatic focus leaves the
    // caret at position 0, which reads as "my text got replaced".
    view.dispatch({ selection: { anchor: view.state.doc.length } })

    return () => {
      // BEFORE destroy: EditorView.destroy() blurs a focused content DOM,
      // and that blur must find this editor already retired.
      mountedRef.current = false
      if (activeRef.current !== null) clearActiveMarkdownEditor(activeRef.current)
      viewRef.current = null
      view.destroy()
    }
    // Mount-once by design: initialText is the seed, later parent renders
    // must not reset the document under the caret.
  }, [])
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: setAnnotationProjection.of({ threads: threads ?? [], selectedThreadId: null }),
    })
  }, [threads])

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
