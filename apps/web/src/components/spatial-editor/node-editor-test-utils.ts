// Browser-test helpers for the CodeMirror node editor. The old textarea
// exposed `.value`; CodeMirror renders one `.cm-line` element per document
// line, so reading and writing go through these instead of ad-hoc
// selectors duplicated per test file.
import { fireEvent } from '@testing-library/react'

export const nodeEditor = (container: ParentNode): HTMLElement | null =>
  container.querySelector('[data-testid="text-node-editor"]')

export const nodeEditorContent = (container: ParentNode): HTMLElement | null =>
  container.querySelector('[data-testid="text-node-editor"] .cm-content')

/** The open editor's full document, newline-joined; null when closed. */
export function nodeEditorText(container: ParentNode): string | null {
  const content = nodeEditorContent(container)
  if (content === null) return null
  return Array.from(content.querySelectorAll('.cm-line'))
    .map((line) => line.textContent ?? '')
    .join('\n')
}

/**
 * Replaces the open editor's document. Select-all + paste, both handled
 * natively by CodeMirror — paste is deterministic for multiline text where
 * per-key typing is not.
 */
export function fillNodeEditor(container: ParentNode, text: string): void {
  const content = nodeEditorContent(container)
  if (content === null) throw new Error('node editor is not open')
  content.focus()
  fireEvent.keyDown(content, { key: 'a', ctrlKey: true })
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', text)
  // A REAL ClipboardEvent carrying a real DataTransfer — the init-object
  // form does not deliver clipboardData to CodeMirror's paste handler.
  fireEvent(
    content,
    new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
  )
}
