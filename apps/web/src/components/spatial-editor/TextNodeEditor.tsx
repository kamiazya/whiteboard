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
 */
import { useEffect, useRef, useState } from 'react'
import type { Box } from './geometry.js'

export interface TextNodeEditorProps {
  readonly box: Box
  readonly initialText: string
  readonly onCommit: (text: string) => void
  readonly onCancel: () => void
}

export function TextNodeEditor({ box, initialText, onCommit, onCancel }: TextNodeEditorProps) {
  const [value, setValue] = useState(initialText)
  const mountedRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    mountedRef.current = true
    textareaRef.current?.focus()
    return () => {
      mountedRef.current = false
    }
  }, [])

  const commit = () => {
    if (!mountedRef.current) return
    onCommit(value)
  }

  return (
    <textarea
      ref={textareaRef}
      data-testid="text-node-editor"
      value={value}
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.width,
        height: box.height,
        resize: 'none',
        boxSizing: 'border-box',
      }}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          commit()
        }
      }}
    />
  )
}
