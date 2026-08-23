import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusEditable } from '../../test-utils/focus-editable.js'
import { MarkdownEditor } from './MarkdownEditor.js'

afterEach(() => {
  cleanup()
  window.localStorage.removeItem('whiteboard.markdown-view-mode')
})

describe('empty-document caret', () => {
  it('the native caret sits at the line start, not after the placeholder text', async () => {
    // On Android the OS draws its selection handle at the NATIVE caret. The
    // placeholder is an inline-block span inside the first line, so a caret
    // that lands after it renders mid-line — the "cursor appears in a weird
    // place" report on an empty document. The caret must sit where typing
    // will put the first character: the line start.
    const { getByTestId } = render(
      <MarkdownEditor initialViewMode="write" value="" onChange={() => {}} />,
    )
    const resolveEditable = () =>
      getByTestId('markdown-source-pane').querySelector('[contenteditable="true"]')
    await focusEditable(resolveEditable)
    // Read AFTER the helper settled, not from a node captured before it: the
    // contentDOM it focused is the one this test means.
    const editable = resolveEditable() as HTMLElement

    const placeholder = editable.querySelector('.cm-placeholder')
    expect(placeholder).not.toBeNull()
    const line = editable.querySelector('.cm-line')
    expect(line).not.toBeNull()

    // The mechanism, not only the symptom: the placeholder must sit outside
    // the line's flow (desktop Chromium puts the caret at line start either
    // way, so only this guards the Android handle placement), while the
    // empty line keeps a real height for it to overlay.
    expect(getComputedStyle(placeholder as Element).position).toBe('absolute')
    expect((line as HTMLElement).getBoundingClientRect().height).toBeGreaterThan(10)

    await vi.waitFor(() => {
      const selection = window.getSelection()
      expect(selection?.rangeCount).toBeGreaterThan(0)
      const caret = selection!.getRangeAt(0).getBoundingClientRect()
      const lineRect = (line as HTMLElement).getBoundingClientRect()
      // Within a character's width of the line start — never past the
      // placeholder's span.
      expect(caret.left - lineRect.left).toBeLessThan(10)
    })
  })
})
