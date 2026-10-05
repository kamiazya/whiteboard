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

import { growsPast } from '@kamiazya/whiteboard-model'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import type { Box } from '../../lib/spatial/geometry.js'
import { EditorExitHint } from '../EditorExitHint.js'

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
  /**
   * The most text the draft may hold, and the words a refused edit is
   * explained in. An edit that would leave the draft longer than `max` AND
   * longer than it was is refused whole, so a value stored before the bound
   * can still be shortened.
   */
  readonly lengthLimit?: TextLengthLimit
}

export interface TextLengthLimit {
  readonly max: number
  readonly describe: (length: number) => string
}

/**
 * The draft, held to `limit`: `offer` takes an edit unless it would leave the
 * draft past the limit and longer than it was, and answers whether it did.
 * `refusal` explains the last refused edit until the next one lands.
 */
function useLimitedDraft(initialText: string, limit: TextLengthLimit | undefined) {
  const [value, setValue] = useState(initialText)
  const [refused, setRefused] = useState<number | null>(null)
  const offer = (next: string): boolean => {
    if (limit !== undefined && growsPast(limit.max, value.length, next.length)) {
      setRefused(next.length)
      return false
    }
    setRefused(null)
    setValue(next)
    return true
  }
  const refusal = refused === null || limit === undefined ? null : limit.describe(refused)
  return { value, offer, refusal }
}

/** A refused edit's explanation, above the draft where it covers neither the text nor the exit strip. */
function LengthLimitNotice({
  box,
  testId,
  text,
}: {
  readonly box: Box
  readonly testId: string
  readonly text: string
}) {
  return (
    <output
      data-testid={`${testId}-limit`}
      style={{
        display: 'block',
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.width,
        transform: 'translateY(calc(-100% - 4px))',
        padding: '2px 4px',
        fontSize: 11,
        lineHeight: 1.3,
        background: 'var(--muted)',
        color: 'var(--foreground)',
        borderBottom: '1px solid var(--destructive)',
      }}
    >
      {text}
    </output>
  )
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
  lengthLimit,
}: TextNodeEditorProps) {
  const { value, offer, refusal } = useLimitedDraft(initialText, lengthLimit)
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
          if (offer(e.target.value)) onChange?.(e.target.value)
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
      {refusal !== null && <LengthLimitNotice box={box} testId={testId} text={refusal} />}
      <EditorExitHint
        onDone={commit}
        onCancel={cancel}
        canvasOverlay
        placement={{
          left: box.x,
          right: box.x + box.width,
          top: box.y + box.height + 6,
          scale: exitHintScale,
        }}
      />
    </>
  )
}
