/**
 * A positioned `<textarea>` overlaying a `text` node's box. Commits on
 * blur or Cmd/Ctrl+Enter, cancels on Escape. The commit is guarded so a
 * blur firing during/after unmount never calls `onCommit`.
 *
 * `onPointerDown` stops propagation: the textarea sits exactly on top of
 * the node it edits, so an unguarded pointerdown placing the caret would
 * bubble to the editor root's hit-test, resolve to the same node, and
 * hijack the gesture into a move — unmounting this component (and
 * discarding the in-progress edit) before its own blur-commit ever runs.
 *
 * `finishedRef` makes the commit/cancel transition terminal: once either
 * has fired, the other becomes a no-op. Without it, Escape (cancel) then a
 * later blur (commit) would resurrect a value the user just discarded, and
 * Cmd/Ctrl+Enter (commit) then blur would call `onCommit` a second time —
 * `onCancel` unmounting synchronously is not guaranteed, so `mountedRef`
 * alone cannot prevent either.
 */

import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { EditorExitHint } from '../EditorExitHint.js'
import type { Box } from './geometry.js'

export interface TextNodeEditorProps {
  readonly box: Box
  readonly initialText: string
  /** Overrides the testid for non-node uses (e.g. the edge label editor). */
  readonly testId?: string
  /**
   * Screen-size correction for the exit strip: the strip is positioned in
   * canvas coordinates and would otherwise scale with the zoom, and a tap
   * target has a screen size, not a canvas size. Callers pass `1 / zoom`.
   */
  readonly exitHintScale?: number
  /**
   * Merged over the base style. Callers pass the edited object's own
   * rendered appearance (fill, font, padding) so entering edit mode reads
   * as "the text became editable" rather than a second box appearing —
   * and an OPAQUE background here is load-bearing: the app's CSS reset
   * makes form controls transparent, which would let the pre-edit SVG
   * text show through under the draft.
   */
  readonly style?: CSSProperties
  readonly onCommit: (text: string) => void
  readonly onCancel: () => void
  /** Fires on every keystroke so a caller can track the in-progress value (e.g. to commit it if a gesture interrupts the edit). */
  readonly onChange?: (text: string) => void
}

export function TextNodeEditor({
  box,
  initialText,
  testId = 'text-node-editor',
  exitHintScale,
  style,
  onCommit,
  onCancel,
  onChange,
}: TextNodeEditorProps) {
  const [value, setValue] = useState(initialText)
  const mountedRef = useRef(true)
  const finishedRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    mountedRef.current = true
    const textarea = textareaRef.current
    textarea?.focus()
    // Continue typing where the text ends — programmatic focus leaves the
    // caret at position 0, which reads as "my text got replaced".
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length)
    return () => {
      mountedRef.current = false
    }
  }, [])

  const commit = () => {
    if (!mountedRef.current || finishedRef.current) return
    finishedRef.current = true
    onCommit(value)
  }

  const cancel = () => {
    if (finishedRef.current) return
    finishedRef.current = true
    onCancel()
  }

  return (
    <>
      <textarea
        ref={textareaRef}
        aria-keyshortcuts="Meta+Enter Control+Enter"
        data-testid={testId}
        value={value}
        style={{
          position: 'absolute',
          left: box.x,
          top: box.y,
          width: box.width,
          height: box.height,
          resize: 'none',
          boxSizing: 'border-box',
          // Explicit, because the canvas root turns selection OFF and this
          // inherits from it — without this the caret cannot select the text it
          // is editing.
          userSelect: 'text',
          ...style,
        }}
        onChange={(e) => {
          setValue(e.target.value)
          onChange?.(e.target.value)
        }}
        data-editor-overlay
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            commit()
          }
        }}
      />
      <EditorExitHint
        onDone={commit}
        onCancel={cancel}
        canvasOverlay
        style={{
          position: 'absolute',
          left: box.x,
          top: box.y + box.height + 6,
          transform: exitHintScale === undefined ? undefined : `scale(${exitHintScale})`,
          transformOrigin: 'top left',
        }}
      />
    </>
  )
}
